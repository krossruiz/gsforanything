import * as THREE from 'three';
import { XRButton } from './threejsAddons/XRButton.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { buildButtonLayout, drawButtonsToCanvas, hitTestButtons, mountButtonsToDOM } from './menuSystem.js';
import { paintElementToCanvas } from './htmlInCanvas.js';
import { mountCodeHighlight } from './syntaxHighlight.js';
import {
	GS_VERSION,
	loadVersionManifest,
	mergeVersionList,
	isCurrentVersionEntry
} from './version.js';
import * as GSContext from './creationContext.js';
import * as GSMerge from './communityMerge.js';
import * as ChatPrompt from './chatPrompt.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { initSceneExport } from './exporter.js';
import { createTwinSticks } from './twinSticks.js';
import { createCameraControls, CAMERA_MODES, STICK_MODES, normalizeCameraMode, ORBIT_TARGET, isTextEntry } from './cameraControls.js';
// p5.js sketch import (paste / file / zip / URL -> panel in the scene). Self-contained;
// it only uses the window.gs* hooks set up next to gsCreateP5Surface below.
import './p5Import.js';

// ============================================================================
// Configuration
// ============================================================================
const CHAT_PANEL_WIDTH = 1.2;
const CHAT_PANEL_HEIGHT = 0.8;
const CHAT_PANEL_DISTANCE = 1.5;
const MESSAGE_FONT_SIZE = 24;
const SCROLL_SPEED = 3; // lines per second at full thumbstick deflection
const THUMBSTICK_DEADZONE = 0.15;
const MOVE_SPEED = 1.5;  // metres/second at full left-thumbstick deflection
const TURN_SPEED = 1.8;  // radians/second at full right-thumbstick deflection
const INPUT_PANEL_WIDTH = 1.2;
const INPUT_PANEL_HEIGHT = 0.15;
const INPUT_PANEL_GAP = 0.05;
const KEYBOARD_PANEL_WIDTH = 1.2;
const KEYBOARD_PANEL_HEIGHT = 0.45;
const KEYBOARD_PANEL_GAP = 0.05;
const SIDE_PANEL_WIDTH = 0.3;
const SIDE_PANEL_HEIGHT = 0.8;
const SIDE_PANEL_GAP = 0.06;
const SCENE_PANEL_WIDTH = 0.52;
const SCENE_PANEL_HEIGHT = 0.8;
const SCENE_PANEL_GAP = 0.06;

// ============================================================================
// Scene Setup
// ============================================================================
const appElement = document.getElementById('app');

const scene = new THREE.Scene();
scene.background = null; // transparent for passthrough

// Render distance, shared by desktop, phone and VR. VR and the windowed view use
// this same camera: three.js copies camera.near/far into the XR session's
// depthNear/depthFar every frame, so VR draws RENDER_NEAR..RENDER_FAR metres from
// the headset. See syncRenderDistance() for how desktop matches it.
const RENDER_NEAR = 0.1;
const RENDER_FAR = 100;
const RENDER_EYE_HEIGHT = 1.6; // where the VR view starts in the player rig (local-floor)
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, RENDER_NEAR, RENDER_FAR);
camera.position.set(0, 1.6, 0);

// ============================================================================
// In-world menu render priority (Three.js layer 1)
// ============================================================================
// The XR panels, head-locked HUD, and aim reticles must draw above every mesh
// the user or injected code adds. Those meshes stay on layer 0 (the default).
// The menu is taken off layer 0 and placed on layer 1.
//
// Layer 1 is not a depth override: WebXR renders the scene layer and the eye
// layer in one pass, so a closer mesh would still win the depth test. Menu
// materials therefore also get depthTest/depthWrite off, transparent:true (so
// they sort in the late transparent pass), and a high renderOrder.
//
// Three r180 reserves layer 1 for the LEFT eye and layer 2 for the RIGHT eye
// (WebXRManager masks the right eye to layers 0 and 2; StereoCamera does the
// same for cardboard). The menu is also enabled on layer 2 so it does not
// vanish in the right eye. Scene objects are never put on layer 1 or 2.
const MENU_LAYER = 1;
const MENU_RIGHT_EYE_LAYER = 2;
const MENU_RENDER_ORDER = 10000;
const MENU_RETICLE_RENDER_ORDER = 10001;
const menuPriorityRoots = [];

function registerMenuRoot(object, renderOrder = MENU_RENDER_ORDER) {
	if (!object || menuPriorityRoots.indexOf(object) !== -1) return;
	object.userData.menuRenderOrder = renderOrder;
	menuPriorityRoots.push(object);
}

function applyMenuLayerPriority() {
	// Desktop camera only tests layer 0 unless layer 1 is enabled. Enabling it
	// does not disable layer 0, so windowed mode still draws the scene. XR eye
	// cameras force layers 1 and 2 themselves; cardboard stereo cameras are
	// re-enabled here in case something clears their masks.
	camera.layers.enable(MENU_LAYER);
	stereoCam.cameraL.layers.enable(MENU_LAYER);
	stereoCam.cameraR.layers.enable(MENU_RIGHT_EYE_LAYER);

	// Raycasters default to layer 0. Menu meshes are not on layer 0, so the
	// UI rays must test layer 1 or panel hits/reticles stop registering.
	raycaster.layers.enable(MENU_LAYER);
	_hitRaycaster.layers.enable(MENU_LAYER);

	for (let i = 0; i < menuPriorityRoots.length; i++) {
		const root = menuPriorityRoots[i];
		if (!root) continue;
		const rootOrder = root.userData.menuRenderOrder || MENU_RENDER_ORDER;
		root.traverse((obj) => {
			// set() drops every other layer, including 0. Layer 2 keeps the
			// right eye. Children parented under a menu root later (injected
			// code, hud.add, panel.add, ...) are picked up by this traverse.
			obj.layers.set(MENU_LAYER);
			obj.layers.enable(MENU_RIGHT_EYE_LAYER);
			const order = obj.userData.menuRenderOrder || rootOrder;
			if (obj.renderOrder < order) obj.renderOrder = order;
			const mats = obj.material;
			if (!mats) return;
			const list = Array.isArray(mats) ? mats : [mats];
			for (let m = 0; m < list.length; m++) {
				const mat = list[m];
				if (!mat) continue;
				// transparent:true puts the menu in the transparent pass so it
				// paints after opaque AND after ordinary transparent scene meshes.
				mat.transparent = true;
				mat.depthTest = false;
				mat.depthWrite = false;
			}
		});
	}
}

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
appElement.appendChild(renderer.domElement);
renderer.setClearColor(0x000000, 0.0);
renderer.domElement.style.touchAction = 'none';

// Touch drags (one finger and two) were panning/overscrolling the browser
// page instead of orbiting the scene. touch-action:none on #app/canvas
// (index.html) opts the browser out; preventDefault on touchmove covers
// Safari, which still moves the visual viewport. Skip editable fields and
// any element that can actually scroll (chat lists, code editor) so typing
// and in-panel scrolling keep working. Buttons still receive taps — this
// does not call preventDefault on touchstart/click. Desktop mouse is untouched.
function touchTargetAllowsBrowserScroll(target) {
	if (!(target instanceof Element)) return false;
	if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
	let el = target;
	while (el && el !== document.body && el !== document.documentElement) {
		const style = window.getComputedStyle(el);
		const oy = style.overflowY;
		const ox = style.overflowX;
		const scrollsY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
		const scrollsX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth + 1;
		if (scrollsY || scrollsX) return true;
		el = el.parentElement;
	}
	return false;
}
function preventPagePanFromTouch(e) {
	if (touchTargetAllowsBrowserScroll(e.target)) return;
	if (e.cancelable) e.preventDefault();
}
document.addEventListener('touchmove', preventPagePanFromTouch, { passive: false, capture: true });
// iOS two-finger drag/pinch moves the page frame via gesture events, which
// touchmove preventDefault does not cover.
document.addEventListener('gesturestart', preventPagePanFromTouch, { passive: false });
document.addEventListener('gesturechange', preventPagePanFromTouch, { passive: false });

// Desktop (non-XR) camera controls are the stock three.js addons (Orbit,
// Map, Trackball, Fly, First person); see cameraControls.js and the Controls
// tab section below. They are disabled while WebXR or Cardboard drives the camera.

// Walk-in-AR only: finger-driven transform gizmos for arPlacementRoot (not WebXR).
// Three controls so "All" can show translate + rotate + scale handles together.
let arGizmoVisible = false;
let arGizmoDragging = false;
let arGizmoMode = 'all'; // 'all' | 'translate' | 'rotate' | 'scale'
const arGizmoHelpers = [];
const arTransformByMode = {};
for (const mode of ['translate', 'rotate', 'scale']) {
	const ctrl = new TransformControls(camera, renderer.domElement);
	ctrl.enabled = false;
	ctrl.setMode(mode);
	ctrl.setSize(mode === 'scale' ? 1.2 : 1.35);
	ctrl.space = 'world';
	ctrl.showX = true;
	ctrl.showY = true;
	ctrl.showZ = true;
	ctrl.addEventListener('dragging-changed', (e) => {
		arGizmoDragging = !!e.value;
		// While one handle is grabbed, silence the sibling gizmos so they don't fight.
		for (const other of Object.values(arTransformByMode)) {
			if (other === ctrl) continue;
			if (e.value) {
				other.enabled = false;
			} else if (arGizmoVisible) {
				other.enabled = (arGizmoMode === 'all' || other.getMode() === arGizmoMode);
			}
		}
	});
	const helper = ctrl.getHelper();
	helper.name = `arTransformHelper-${mode}`;
	helper.visible = false;
	scene.add(helper);
	arGizmoHelpers.push(helper);
	arTransformByMode[mode] = ctrl;
}
// Back-compat aliases used by gather/system-object skips
const arTransformControls = arTransformByMode.translate;
const arTransformHelper = arGizmoHelpers[0];

// ============================================================================
// DOM Elements
// ============================================================================
const overlayRoot = document.getElementById('overlay-root');
const chatInput = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const statusElement = document.getElementById('status');
const desktopChat = document.getElementById('desktop-chat');
const desktopChatHeader = document.getElementById('desktop-chat-header');
const desktopChatMessages = document.getElementById('desktop-chat-messages');
const desktopChatInput = document.getElementById('desktop-chat-input');
const desktopSendButton = document.getElementById('desktop-send-button');
const desktopMicButton = document.getElementById('desktop-mic-button');
const desktopAttachButton = document.getElementById('desktop-attach-button');
const desktopAttachInput = document.getElementById('desktop-attach-input');
const desktopAttachmentsRow = document.getElementById('desktop-attachments');
const desktopFilesPickerButton = document.getElementById('desktop-files-picker-button');
const themeFilesPickerButton = document.getElementById('theme-files-picker-button');
const dchatThemeAttachmentsRow = document.getElementById('dchat-theme-attachments');
const dchatFilesList = document.getElementById('dchat-files-list');
const dchatFilesInput = document.getElementById('dchat-files-input');
const dchatFilesUpload = document.getElementById('dchat-files-upload');
const dchatFilesClear = document.getElementById('dchat-files-clear');
const filesPickerModal = document.getElementById('files-picker-modal');
const filesPickerList = document.getElementById('files-picker-list');
const filesPickerCancel = document.getElementById('files-picker-cancel');
const filesPickerConfirm = document.getElementById('files-picker-confirm');
const desktopModelSelect = document.getElementById('desktop-model-select');
const desktopOllamaModelRow = document.getElementById('desktop-ollama-model-row');
const desktopOllamaModelSelect = document.getElementById('desktop-ollama-model-select');
const desktopChatMinimizeBtn = document.getElementById('desktop-chat-minimize');
const desktopChatExpandBtn = document.getElementById('desktop-chat-expand');
const desktopChatReopenBtn = null; // Show Chat removed — restore via Show UI
const chatOverlayBar = document.getElementById('chat-overlay');
const dchatEnvModeMount = document.getElementById('dchat-env-mode');
const dchatEnvControls = document.getElementById('dchat-env-controls');
const dchatColorPicker = document.getElementById('dchat-color-picker');
const dchatColorPreview = document.getElementById('dchat-color-preview');
const dchatBrightness = document.getElementById('dchat-brightness');
const dchatResetCameraBtn = document.getElementById('dchat-reset-camera');
const dchatNavType = document.getElementById('dchat-nav-type');
const dchatScenesButtonsMount = document.getElementById('dchat-scenes-buttons');
const dchatSceneList = document.getElementById('dchat-scene-list');
const dchatExportCombinedMount = document.getElementById('dchat-export-combined-mount');
const dchatCommunityButtonsMount = document.getElementById('dchat-community-buttons');
const dchatCommunityLoadModeMount = document.getElementById('dchat-community-loadmode');
const dchatCommunityList = document.getElementById('dchat-community-list');
const dchatThemesButtonsMount = document.getElementById('dchat-themes-buttons');
const dchatThemesList = document.getElementById('dchat-themes-list');
const dchatThemeChatMessages = document.getElementById('dchat-theme-chat-messages');
const dchatThemeChatInput = document.getElementById('dchat-theme-chat-input');
const dchatThemeChatSend = document.getElementById('dchat-theme-chat-send');
const dchatThemeRemember = document.getElementById('dchat-theme-remember');
const dchatThemeRememberCommunity = document.getElementById('dchat-theme-remember-community');
const dchatCodeEditor = document.getElementById('dchat-code-editor');
const dchatCodeLive = document.getElementById('dchat-code-live');
const dchatCodeApply = document.getElementById('dchat-code-apply');
const dchatCodeRevert = document.getElementById('dchat-code-revert');
const dchatCodeStatus = document.getElementById('dchat-code-status');
const dchatCodeHint = document.getElementById('dchat-code-hint');
const dchatCodeHighlight = document.getElementById('dchat-code-highlight');
const dchatHdriFile = document.getElementById('dchat-hdri-file');
const dchatHdriPick = document.getElementById('dchat-hdri-pick');
const dchatHdriClear = document.getElementById('dchat-hdri-clear');
const dchatHdriUrl = document.getElementById('dchat-hdri-url');
const dchatHdriUrlLoad = document.getElementById('dchat-hdri-url-load');
const dchatHdriBg = document.getElementById('dchat-hdri-bg');
const dchatHdriStatus = document.getElementById('dchat-hdri-status');


// ============================================================================
// Shared menu button specs (menuSystem.js) — the single source of truth for
// every button that has to exist in both the desktop DOM menu and the XR
// canvas panels. Add/rename/recolor a button here and both surfaces update:
// desktop mounts these as a live <svg> (mountButtonsToDOM), XR draws the
// exact same boxes onto its canvas texture (drawButtonsToCanvas) and hit-
// tests controller rays against them (hitTestButtons). All click/hit paths
// funnel into handleMenuAction() below, so behavior only needs to be
// written once too.
// ============================================================================
const ENV_MODE_BUTTONS = [
	{ id: 'vr', label: 'VR (color)', action: 'env:vr' }
];
const EXIT_XR_BUTTON = [
	{ id: 'exitXr', label: 'Exit VR', action: 'env:exit', variant: 'warning' }
];
// Mirrors desktop Environment → Navigation (WASD / First Person). XR grip still cycles Off.
const NAV_MODE_BUTTONS = [
	{ id: 'navFree', label: 'WASD', action: 'env:nav:free' },
	{ id: 'navPlanar', label: 'First Person', action: 'env:nav:planar' }
];
function getLayDownButton() {
	return {
		id: 'layDown',
		label: layDownView ? 'Sit up' : 'Lay down',
		action: 'env:layDown',
		variant: layDownView ? 'active' : 'default'
	};
}
function getWindowAnchorButton() {
	const follow = windowAnchorMode === 'follow';
	return {
		id: 'windowAnchor',
		label: follow ? 'Windows: Follow head' : 'Windows: Fixed',
		action: 'env:windowAnchor',
		variant: follow ? 'active' : 'inactiveToggle'
	};
}
function getHtmlInCanvasButton() {
	return {
		id: 'htmlInCanvas',
		label: htmlInCanvas ? 'HTML in canvas: ON' : 'HTML in canvas',
		action: 'env:htmlInCanvas',
		variant: htmlInCanvas ? 'active' : 'inactiveToggle'
	};
}
const SCENES_BUTTONS = [
	{ id: 'export', label: 'Export', action: 'scenes:export', variant: 'accent' },
	{ id: 'importFile', label: 'Import File', action: 'scenes:importFile' },
	{ id: 'importFolder', label: 'Import Folder', action: 'scenes:importFolder' },
	{ id: 'loadSaved', label: 'Load Saved', action: 'scenes:loadSaved', variant: 'success' },
	{ id: 'clearScene', label: 'Clear scene', action: 'scenes:clear', variant: 'secondary' },
	// Share & 3D export (exporter.js). Desktop/phone: one shortcut to the Share
	// tab. VR (no Share tab there): the Share options as panel buttons.
	{ id: 'openShare', label: 'Share & Export 3D', action: 'scenes:openShareTab', variant: 'accent', desktopOnly: true },
	{ id: 'shareLink', label: 'Share link', action: 'scenes:shareLink', variant: 'accent', xrOnly: true },
	{ id: 'exportGlb', label: 'Save GLB', action: 'scenes:exportModel:glb', variant: 'accent', xrOnly: true },
	{ id: 'exportGltf', label: 'Save glTF', action: 'scenes:exportModel:gltf', variant: 'accent', xrOnly: true },
	{ id: 'exportFbx', label: 'Save FBX', action: 'scenes:exportModel:fbx', variant: 'accent', xrOnly: true },
	{ id: 'exportObj', label: 'Save OBJ', action: 'scenes:exportModel:obj', variant: 'accent', xrOnly: true },
	{ id: 'exportBlender', label: 'Save Blender', action: 'scenes:exportModel:blender', variant: 'accent', xrOnly: true }
];
const SCENES_BUTTONS_DOM = SCENES_BUTTONS.filter((b) => !b.xrOnly);
const SCENES_BUTTONS_XR = SCENES_BUTTONS.filter((b) => !b.desktopOnly);
const EXPORT_COMBINED_BUTTON = [
	{ id: 'exportCombined', label: 'Export Combined', action: 'scenes:exportCombined', variant: 'warning' }
];
const FILES_BUTTONS = [
	{ id: 'uploadFiles', label: 'Upload files', action: 'files:upload', variant: 'accent' },
	{ id: 'clearFiles', label: 'Clear all', action: 'files:clear', variant: 'secondary' }
];
const CODE_BUTTONS = [
	{ id: 'codeLive', label: 'Live updates', action: 'code:toggleLive' },
	{ id: 'codeApply', label: 'Apply', action: 'code:apply', variant: 'accent' },
	{ id: 'codeRevert', label: 'Revert', action: 'code:revert', variant: 'secondary' },
	{ id: 'codeReset', label: 'Full reset', action: 'code:reset', variant: 'warning' }
];
const COMMUNITY_BUTTONS = [
	{ id: 'upload', label: 'Upload Current Scene', action: 'community:upload', variant: 'accent' },
	{ id: 'refresh', label: 'Refresh', action: 'community:refresh' }
];
const THEME_BUTTONS = [
	{ id: 'uploadTheme', label: 'Upload Current Theme', action: 'themes:upload', variant: 'accent' },
	{ id: 'refreshThemes', label: 'Refresh', action: 'themes:refresh' },
	{ id: 'resetTheme', label: 'Reset Default', action: 'themes:reset' }
];
// XR left panel top-level sections (desktop tabs minus Chat/Environment, which
// have their own XR meshes). Community nests Scenes|Themes like desktop.
const SCENE_PANEL_SUB_TABS = [
	{ id: 'scenes', label: 'Scenes', action: 'panel:scenes' },
	{ id: 'files', label: 'Files', action: 'panel:files' },
	{ id: 'code', label: 'Code', action: 'panel:code' },
	{ id: 'community', label: 'Community', action: 'panel:community' }
];
// Desktop top-level tab order for reference (Chat + Environment are separate XR meshes):
// Chat (Scene|Theme) · Environment · Scenes · Files · Code · Community (Scenes|Themes)
const COMMUNITY_NESTED_TABS = [
	{ id: 'scenes', label: 'Scenes', action: 'communitySection:scenes' },
	{ id: 'themes', label: 'Themes', action: 'communitySection:themes' }
];
const CHAT_SUB_TABS = [
	{ id: 'scene', label: 'Scene', action: 'chatSection:scene' },
	{ id: 'theme', label: 'Theme', action: 'chatSection:theme' },
	{ id: 'prompt', label: 'Prompt', action: 'chatSection:prompt' }
];

// Routes both a desktop SVG click and an XR controller-ray/touch hit to the
// same behavior, so the behavior itself is written exactly once.
function handleMenuAction(action) {
	switch (action) {
		case 'env:vr':
			isVRMode = true;
			applyEnvironmentMode();
			renderSidePanel();
			renderDomEnv();
			break;
		case 'env:exit':
			exitXrToDesktop();
			break;
		case 'env:layDown':
			toggleLayDownView();
			break;
		case 'env:htmlInCanvas':
			setHtmlInCanvas(!htmlInCanvas);
			break;
		case 'env:windowAnchor':
			setWindowAnchorMode(windowAnchorMode === 'follow' ? 'fixed' : 'follow');
			break;
		case 'env:nav:free':
			locomotionMode = 'free';
			if (dchatNavType) dchatNavType.value = 'free';
			updateStatus('Locomotion: WASD/free-fly', 'connected');
			renderSidePanel();
			break;
		case 'env:nav:planar':
			locomotionMode = 'planar';
			if (dchatNavType) dchatNavType.value = 'planar';
			updateStatus('Locomotion: First Person', 'connected');
			renderSidePanel();
			break;
		case 'scenes:export':
			showExportModal(false);
			break;
		case 'scenes:exportModel:glb':
		case 'scenes:exportModel:gltf':
		case 'scenes:exportModel:fbx':
		case 'scenes:exportModel:obj':
		case 'scenes:exportModel:blender':
			sceneModelExport.open(action.split(':')[2]);
			break;
		case 'scenes:shareLink':
			shareCurrentScene();
			break;
		case 'scenes:openShareTab':
			document.querySelector('.dchat-tab[data-tab="share"]')?.click();
			break;
		case 'scenes:importFile':
			fileInput.click();
			break;
		case 'scenes:importFolder':
			folderInput.click();
			break;
		case 'scenes:loadSaved':
			loadSceneFromServer();
			break;
		case 'scenes:exportCombined':
			if ((loadedScenes.some(s => s.active) || executedCodeBlocks.length > 0) && loadedScenes.length > 0) {
				showExportModal(true);
			}
			break;
		case 'scenes:clear':
			clearSceneContent();
			break;
		case 'files:upload':
			dchatFilesInput?.click();
			break;
		case 'files:clear':
			clearContextLibrary();
			break;
		case 'code:toggleLive':
			if (dchatCodeLive) {
				dchatCodeLive.checked = !dchatCodeLive.checked;
				if (dchatCodeLive.checked && codeEditorDirty) scheduleLiveCodeApply();
			}
			renderScenePanel();
			break;
		case 'code:apply':
			// Apply hot reloads (changed blocks only, state kept).
			hotReloadFromEditor({ fromLive: false });
			break;
		case 'code:reset':
			// Old behavior: clear the scene and re-run every block from scratch.
			applyCodeFromEditor({ fromLive: false });
			break;
		case 'code:revert':
			revertCodeEditor();
			renderScenePanel();
			break;
		case 'community:upload':
			uploadCurrentSceneToCommunity();
			break;
		case 'community:refresh':
			refreshCommunityScenes();
			break;
		case 'community:loadMode:clear':
			setCommunityLoadMode('clear');
			break;
		case 'community:loadMode:layer':
			setCommunityLoadMode('layer');
			break;
		case 'themes:upload':
			uploadCurrentThemeToCommunity();
			break;
		case 'themes:refresh':
			refreshCommunityThemes();
			break;
		case 'themes:reset':
			applyTheme(DEFAULT_THEME, { announce: true });
			break;
		case 'theme:toggleRemember':
			setRememberTheme(!rememberTheme);
			break;
		case 'panel:scenes':
			scenePanelSubTab = 'scenes';
			renderScenePanel();
			renderInputToCanvas();
			break;
		case 'panel:files':
			scenePanelSubTab = 'files';
			renderScenePanel();
			renderInputToCanvas();
			break;
		case 'panel:code':
			scenePanelSubTab = 'code';
			syncCodeEditorFromState({ force: false });
			codeScrollOffset = 0;
			renderScenePanel();
			renderInputToCanvas();
			break;
		case 'panel:community':
			scenePanelSubTab = 'community';
			renderScenePanel();
			renderInputToCanvas();
			if (communitySection === 'themes') refreshCommunityThemes();
			else refreshCommunityScenes();
			break;
		case 'communitySection:scenes':
			setCommunitySection('scenes');
			renderScenePanel();
			break;
		case 'communitySection:themes':
			setCommunitySection('themes');
			renderScenePanel();
			break;
		case 'chatSection:scene':
			setChatSection('scene');
			break;
		case 'chatSection:theme':
			setChatSection('theme');
			break;
		case 'chatSection:prompt':
			setChatSection('prompt');
			break;
		case 'prompt:reset':
			// Two presses (no confirm() dialog in a headset).
			if (performance.now() < vrPromptResetArmedUntil) {
				vrPromptResetArmedUntil = 0;
				ChatPrompt.clearCustom();
				updateStatus('Using the default prompt', 'connected');
			} else {
				vrPromptResetArmedUntil = performance.now() + 4000;
				setTimeout(() => renderChatToCanvas(), 4100);
			}
			renderChatToCanvas();
			break;
	}
}

/** End the active WebXR session (or mobile pseudo-XR) and return to the desktop DOM UI. */
function exitXrToDesktop() {
	if (mobileXRMode) {
		exitMobileXRMode();
		updateStatus('Exited to desktop', 'connected');
		return;
	}
	const session = renderer?.xr?.getSession?.();
	if (session) {
		session.end().catch((err) => {
			console.warn('XR session end failed:', err);
			updateStatus(`Could not exit XR: ${err?.message || err}`, 'error');
		});
		return;
	}
	updateStatus('Not in an XR session', '');
}

/** Apply (or clear) the lay-down pitch on viewOffset. Only active while in
 *  WebXR / mobile XR so desktop orbit camera stays upright. */
function applyLayDownView() {
	if (!viewOffset) return;
	const inXr = !!(renderer && renderer.xr && renderer.xr.isPresenting) || !!mobileXRMode;
	viewOffset.rotation.x = (layDownView && inXr) ? -Math.PI / 2 : 0;
}

function toggleLayDownView() {
	layDownView = !layDownView;
	applyLayDownView();
	renderSidePanel();
	renderDomEnv();
	const inXr = !!(renderer && renderer.xr && renderer.xr.isPresenting) || !!mobileXRMode;
	if (layDownView) {
		updateStatus(inXr
			? 'Lay-down view on — look toward the ceiling to face the scene'
			: 'Lay-down view armed — takes effect in AR/VR', 'connected');
	} else {
		updateStatus('Sit-up view restored', 'connected');
	}
}

// ============================================================================
// State
// ============================================================================
let messages = [];       // Full messages for API context (includes raw code blocks)
let displayMessages = []; // Cleaned messages for canvas display
let isLoading = false;
let selectedBackend = null; // backend key from /api/backends (e.g. 'claude', 'openai-sol', 'ollama') - set once it resolves
let backendLabels = {}; // id -> display label from /api/backends
let backendProviders = {}; // id -> 'claude' | 'openai' | 'ollama' from /api/backends

/** Provider for a backend key; falls back to the key prefix for older servers. */
function backendProvider(id) {
	if (backendProviders[id]) return backendProviders[id];
	if (id === 'ollama') return 'ollama';
	return /^openai/.test(id || '') ? 'openai' : 'claude';
}

/** Human-readable name for the currently selected model/provider. */
function getActiveModelDisplayName() {
	if (selectedBackend === 'ollama') {
		const name = selectedOllamaModel || desktopOllamaModelSelect?.value;
		if (name && !/^Checking|^No local|^Could not/.test(name)) return name;
		return 'Ollama';
	}
	const fromMap = backendLabels[selectedBackend];
	if (fromMap) return fromMap;
	const opt = desktopModelSelect?.selectedOptions?.[0];
	if (opt?.textContent) {
		return opt.textContent.split('—')[0].trim() || 'Assistant';
	}
	const fallbacks = {
		claude: 'Claude',
		fable: 'Claude Fable',
		openai: 'GPT6 Astra',
		'openai-sol': 'GPT6.1 Sol',
		'openai-6-sol': 'GPT6 Sol',
		'openai-luna': 'GPT6 Luna',
		'claude-opus-55': 'Claude Opus 5.5',
		'claude-sonnet-55': 'Claude Sonnet 5.5',
		'claude-haiku-55': 'Claude Haiku 5.5',
		ollama: 'Ollama'
	};
	return fallbacks[selectedBackend] || 'Assistant';
}

function thinkingStatusText() {
	return `${getActiveModelDisplayName()} is thinking...`;
}
let selectedOllamaModel = null; // e.g. 'llama3.2:latest' - set once the Ollama model list loads
let cachedPrompts = null; // { systemPrompt, fixCodePrompt, themePrompt } - fetched once from /api/prompts
let pendingAttachments = []; // files staged via the 📎 / Files picker, sent with the next scene message - see buildUserContent()
let pendingThemeAttachments = []; // Files-library picks staged for theme chat
let contextLibrary = []; // persisted Files-tab library (IndexedDB)
let filesPickerTarget = 'scene'; // 'scene' | 'theme'
let filesPickerSelected = new Set();

// Ollama always runs on the SAME machine as the browser (this is what makes
// it "local"), regardless of whether this page itself was loaded from
// Vercel or from `python run.py`. So instead of proxying through this app's
// own server (which, when deployed, has no network path to the visitor's
// laptop at all), the browser talks to the user's Ollama directly.
//
// This only actually works when THIS PAGE is also served from localhost
// (i.e. via `python run.py`, not the hosted Vercel site). Reaching a
// loopback address (127.0.0.1/localhost) from a page loaded off a public
// origin is blocked by the browser's Private Network Access policy - unlike
// ordinary CORS, this can't be opted into via Ollama's OLLAMA_ORIGINS
// setting (Ollama doesn't send the special Access-Control-Allow-Private-
// Network response header the preflight requires), so the request just
// hangs/never resolves rather than failing fast. Confirmed empirically:
// identical fetch from https://localhost:PORT succeeds instantly, the same
// fetch from the hosted Vercel origin never settles at all.
const OLLAMA_BASE_URL = 'http://localhost:11434';
const IS_LOCAL_PAGE = ['localhost', '127.0.0.1'].includes(location.hostname);
const OLLAMA_UNAVAILABLE_HOSTED_MSG =
	'Ollama only works when this app is run locally, not from the hosted site: browsers block a ' +
	'public page like this one from reaching a service on your own machine (Private Network Access) - ' +
	'this is a browser security rule, not something Ollama\'s settings can override. Run `python run.py` ' +
	'locally to use Ollama models.';

function fetchWithTimeout(url, options, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function listOllamaModels() {
	if (!IS_LOCAL_PAGE) throw new Error(OLLAMA_UNAVAILABLE_HOSTED_MSG);
	let res;
	try {
		res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {}, 4000);
	} catch (e) {
		throw new Error(`Could not reach Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running.`);
	}
	if (!res.ok) throw new Error(`Ollama responded with ${res.status}`);
	const data = await res.json();
	return (data.models || []).map(m => m.name);
}

// Calls Ollama directly from the browser and normalizes the response into
// the same { content: [{ text }] } shape the rest of the chat code expects
// from the server-proxied backends.
async function callOllamaDirect(systemPrompt, chatMessages, model, maxTokens = 16384) {
	if (!IS_LOCAL_PAGE) throw new Error(OLLAMA_UNAVAILABLE_HOSTED_MSG);
	if (!model) throw new Error('No Ollama model selected.');
	let res;
	try {
		res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model,
				stream: false,
				options: { num_predict: maxTokens },
				messages: [{ role: 'system', content: systemPrompt }, ...chatMessages]
			})
		}, 120000); // generous - local inference can be slow, especially cold-loading a model
	} catch (networkErr) {
		throw new Error(`Could not reach Ollama at ${OLLAMA_BASE_URL}. Make sure Ollama is running.`);
	}
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`Ollama returned non-JSON (${res.status}): ${text.slice(0, 150)}`);
	}
	if (!res.ok) throw new Error(data.error || `Ollama error: ${res.status}`);
	return { content: [{ text: data.message?.content || '' }] };
}
let chatPanel = null;
let chatTexture = null;
let chatCanvas = null;
let chatContext = null;
let inputPanel = null;
let inputTexture = null;
let inputCanvas = null;
let inputContext = null;
let inputText = '';
let keyboardPanel = null;
let keyboardTexture = null;
let keyboardCanvas = null;
let keyboardContext = null;
let keyboardShift = false;    // uppercase next character key
let keyboardSymbols = false;  // symbol layer toggled on
let keyboardKeyRects = [];    // hit rectangles: { x, y, w, h, value, action }
let keyboardCollapsed = false; // keyboard hidden to free up the view
// When on during an immersive VR session, the world-space menu shows a live
// snapshot of the desktop #desktop-chat element instead of the canvas-drawn
// chat / scene / input panels. The side panel stays so this toggle (and Exit
// VR) remain reachable. See htmlInCanvas.js for why this is not CSS3D.
let htmlInCanvas = false;
let htmlInCanvasPanel = null;
let htmlInCanvasCanvas = null;
let htmlInCanvasTexture = null;
let htmlInCanvasAspect = 0;
let htmlKeyboardForDom = false; // XR keyboard targets a focused field inside #desktop-chat
let sidePanelHtmlButtonBoxes = [];
let _htmlPaintAt = 0;
let keyboardHoverIndex = -1;  // index into keyboardKeyRects the pointer is over
let rayVisible = true;        // controller ray lines shown (cursor always shows)
let hudStatusPanel = null;    // head-locked status badge (mirrors DOM #status)
let hudStatusCanvas = null;
let hudStatusContext = null;
let hudStatusTexture = null;
let uiCollapsed = false;      // all main panels hidden for an unobstructed scene
let uiTogglePanel = null;     // head-locked Hide/Show-UI button (never collapses)
let uiToggleCanvas = null;
let uiToggleContext = null;
let uiToggleTexture = null;
let player = null;            // rig holding the camera + controllers (locomotion)
let viewOffset = null;        // child of player: pitch remapping for lay-down AR/VR view
let layDownView = false;      // when true (in XR), pitch viewOffset -90° for supine viewing
let locomotionMode = 'free';  // 'off' (thumbsticks scroll) | 'planar' (First Person) | 'free' (WASD) - see dchat-nav-type
let _locoPrevTime = 0;        // previous frame timestamp for dt

// Speech-to-text (in-browser Whisper via transformers.js — cross-platform)
let speechSupported = false;   // getUserMedia + MediaRecorder available
let micMode = 'off';           // 'off' | 'always' | 'ptt'
let pttHand = null;            // handedness that started push-to-talk
let sttPipelinePromise = null; // lazy-loaded Whisper ASR pipeline (Promise)
let sttModelReady = false;     // model finished loading at least once
let micStream = null;          // active getUserMedia MediaStream
let mediaRecorder = null;      // MediaRecorder for the current utterance
let recordedChunks = [];       // audio blobs for the current utterance
let sttBusy = false;           // a transcription is in flight
let vadContext = null;         // AudioContext used for voice-activity detection
let vadAnalyser = null;        // AnalyserNode sampled each frame from the XR loop
let vadData = null;            // reusable Float32Array for analyser samples
let vadSpeaking = false;       // VAD currently hears speech
let vadSilenceMs = 0;          // ms of trailing silence after speech
let vadLastTime = 0;           // timestamp of last VAD tick
let chatScrollOffset = 0; // in lines, 0 = scrolled to bottom (newest)
let sidePanel = null;
let sideTexture = null;
let sideCanvas = null;
let sideContext = null;
let isVRMode = true;
let vrBgHue = 220;       // 0-360
let vrBgSat = 0.15;      // 0-1
let vrBgLight = 0.12;    // 0-1
let vrSkybox = null;     // inverted sphere to block passthrough in VR mode
let scenePanel = null;
let sceneTexture = null;
let sceneCanvas = null;
let sceneContext = null;
let executedCodeBlocks = [];  // vr-exec code blocks from current chat session
let loadedScenes = [];        // imported scene files: { id, name, thumbnail, codeBlocks, active, createdAt, _thumbImage }
let sceneScrollOffset = 0;
let sceneFileExtension = 'vrscene';
let scenePanelSubTab = 'scenes'; // 'scenes' | 'files' | 'code' | 'community' - see SCENE_PANEL_SUB_TABS
let communityScenesCache = []; // last-fetched list, so the XR panel has something to draw without re-fetching every frame
let communityThemesCache = [];
let communitySection = 'scenes'; // Community tab: 'scenes' | 'themes'
// Community scene load: 'clear' blanks the world first (default); 'layer' adds.
let communityLoadMode = 'clear';
// Bumped by a clear-load (and used to drop stale applies). See beginCommunityLoad.
let communityClearEpoch = 0;
let communityLayerCancel = 0;
// In-flight fetches keyed by `${mode}:${communityKey}` so spam-clicks share one apply.
const communityLoadInflight = new Map();
// Applies run one at a time so two loads can't scene.add while the other is still executing.
let communityApplyChain = Promise.resolve();
let chatSection = 'scene'; // Chat tab: 'scene' | 'theme' | 'prompt'
let vrPromptResetArmedUntil = 0; // XR Chat → Prompt: first Reset press arms, second resets
let displayOnlyMode = false; // share URL opened with editor chrome stripped
let pendingShare = null; // share modal payload { id, name, editorUrl, viewUrl }
let codeEditorDirty = false; // user has unsaved edits in Code tab
let codeHighlightApi = null; // set when Code tab highlight layer mounts
// HDRI state (textures filled later by initHdriControls; checked in applyEnvironmentMode)
let hdriEquirect = null;
let hdriPMREM = null;
let hdriObjectUrl = null;
let hdriPersistUrl = null;
let hdriUseAsBackground = true;
let pmremGenerator = null;
const HDRI_URL_STORAGE_KEY = 'gs-hdri-url';
let codeEditorApplying = false;
let codeEditorLiveTimer = null;
let codeEditorLastApplied = ''; // last successfully applied / synced source
const CODE_EDITOR_LIVE_DEBOUNCE_MS = 500;

let pendingRename = null;
let pendingRenameKind = 'scene'; // 'scene' | 'theme'
let currentTheme = null; // last applied theme object { name, cssVars, customCSS }
let themeChatMessages = []; // API context for /api/theme-chat
let themeChatLoading = false;
// Button hitboxes from the most recent draw of each canvas panel, reused
// by handleSidePanelHit/handleScenePanelHit (see menuSystem.js hitTestButtons).
let sidePanelEnvButtonBoxes = [];
let sidePanelExitButtonBoxes = [];
let sidePanelNavButtonBoxes = [];
let sidePanelWheelHit = { cx: 128, cy: 290, r: 95, innerR: 20 };
let sidePanelSliderHit = { y: 420, h: 30, pad: 24 };
let scenePanelButtonBoxes = [];
let scenePanelSubTabBoxes = [];
let scenePanelNestedTabBoxes = []; // Community Scenes|Themes nested tabs
let scenePanelListTop = 0; // set by renderScenePanel, reused by handleScenePanelHit
let chatPanelSubTabBoxes = []; // Chat Scene|Theme subtabs on center panel
let chatThemeRememberBoxes = []; // XR theme-chat "Remember theme" toggle
let codeScrollOffset = 0; // line scroll for XR Code panel
let filesScrollOffset = 0; // row scroll for XR Files panel
let systemObjectIds = new Set();
let systemOverlayIds = new Set();

// ============================================================================
// Expose globals for vr-exec code injection
// ============================================================================
window.THREE = THREE;
window.scene = scene;
window.camera = camera;
window.renderer = renderer;
window._vrAnimations = [];
// Canvas surfaces made by gsCreateCanvasSurface / gsCreateP5Surface (see the
// Environment + Dependencies section); disposed when the scene is cleared.
const gsSurfaces = new Set();

// Head-locked anchor for HUD elements the user *explicitly* asks to follow them.
// It is a child of the camera, so its origin matches the camera's translation.
const hud = new THREE.Group();
hud.name = 'hud';
camera.add(hud);

// Player rig ("dolly"): the camera (and, later, the controllers) ride inside it.
// Moving/rotating this group is the WebXR-correct way to move the user — three.js
// composes the rig's transform with the live headset pose. The camera must be in
// the scene graph for the HUD's children to render, which it now is via `player`.
// viewOffset sits between player and camera/controllers so lay-down pitch remaps
// the view without rotating the locomotion yaw rig (player.rotateY stays world-up).
player = new THREE.Group();
player.name = 'player';
viewOffset = new THREE.Group();
viewOffset.name = 'viewOffset';
viewOffset.add(camera);
player.add(viewOffset);
scene.add(player);

window.hud = hud;

// World-anchored content root used in Walk-in-AR: scene content sits here on a
// ground plane and can be dragged with a finger. Outside AR it stays at origin
// and is unused (content lives directly under `scene`).
const arPlacementRoot = new THREE.Group();
arPlacementRoot.name = 'arPlacementRoot';
scene.add(arPlacementRoot);
window.arPlacementRoot = arPlacementRoot;

let arPlacementMarker = null; // subtle ring shown only in Walk-in-AR
let arDragging = false;
let arDragPointerId = null;
const _arGroundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _arRaycaster = new THREE.Raycaster();
const _arNdc = new THREE.Vector2();
const _arHit = new THREE.Vector3();
const _arLastHit = new THREE.Vector3();
const _arFwd = new THREE.Vector3();
const _arCamPos = new THREE.Vector3();

// ============================================================================
// XR Button Setup — immersive-vr only (Cardboard is separate, below).
// immersive-ar is not requested.
// ============================================================================
const xrEntryButton = XRButton.createButton(renderer, {
	optionalFeatures: ['hit-test', 'dom-overlay'],
	domOverlay: { root: overlayRoot }
});
// No-WebXR fallback is an <a> without an id; give it the same id for styling.
if (!xrEntryButton.id) xrEntryButton.id = 'XRButton';
// Lives in the bottom #gs-dock next to the version button (see index.html).
const gsDock = document.getElementById('gs-dock');
if (gsDock) {
	gsDock.insertBefore(xrEntryButton, document.getElementById('gs-version-btn'));
} else {
	document.body.appendChild(xrEntryButton);
}
// XRButton rewrites textContent (ENTER VR / EXIT VR / VR NOT SUPPORTED);
// mirror that into data-xr-state so the dock can style usable vs. not.
function syncXrEntryButtonState() {
	const t = (xrEntryButton.textContent || '').toLowerCase();
	xrEntryButton.dataset.xrState = t.includes('exit') ? 'exit' : t.includes('enter') ? 'enter' : 'unavailable';
}
syncXrEntryButtonState();
new MutationObserver(syncXrEntryButtonState).observe(xrEntryButton, { childList: true, characterData: true, subtree: true });

// ============================================================================
// Mobile pseudo-XR: Google Cardboard (stereo + gyro) for phones that can't
// do immersive-vr (iPhone Safari has no WebXR; some Android browsers don't
// either). No 6DOF. Gyro matches look to the phone. Hold-to-walk nudges the
// camera; touch never orbits/rotates the view. AR / Walk-in-AR is not offered.
// ============================================================================
let mobileXRMode = null; // null | 'cardboard'
let mobileMoveHeld = false;
let arVideoStream = null;
const stereoCam = new THREE.StereoCamera();
stereoCam.eyeSep = 0.064; // average human interpupillary distance, metres

const cardboardBtn = document.getElementById('cardboard-btn');
const mobileXRExitBtn = document.getElementById('mobile-xr-exit');
const mobileXRWalkBtn = document.getElementById('mobile-xr-walk');
const mobileXrGizmoBar = document.getElementById('mobile-xr-gizmo-bar');
const mobileXrGizmoToggle = document.getElementById('mobile-xr-gizmo-toggle');
const mobileXrGizmoModes = document.getElementById('mobile-xr-gizmo-modes');
const mobileXrGizmoAll = document.getElementById('mobile-xr-gizmo-all');
const mobileXrGizmoTranslate = document.getElementById('mobile-xr-gizmo-translate');
const mobileXrGizmoRotate = document.getElementById('mobile-xr-gizmo-rotate');
const mobileXrGizmoScale = document.getElementById('mobile-xr-gizmo-scale');
const arVideoEl = document.getElementById('ar-camera-feed');

const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Cardboard only when immersive-vr isn't available. immersive-ar is not checked.
async function refreshMobileXRButtons() {
	if (!cardboardBtn) return;
	if (!isMobileUA || mobileXRMode) {
		cardboardBtn.hidden = true;
		return;
	}
	let vrOk = false;
	if ('xr' in navigator) {
		try { vrOk = await navigator.xr.isSessionSupported('immersive-vr'); } catch { /* unsupported */ }
	}
	cardboardBtn.hidden = vrOk;
}

// Keep the Cardboard close X above the canvas, chat window, and modals.
function raiseMobileXRExitButton() {
	if (!mobileXRExitBtn) return;
	mobileXRExitBtn.style.zIndex = '2147483647';
	mobileXRExitBtn.style.pointerEvents = 'auto';
	document.body.appendChild(mobileXRExitBtn);
}
refreshMobileXRButtons();

// --- Device orientation → camera rotation (standard three.js algorithm) ---
const _doZee = new THREE.Vector3(0, 0, 1);
const _doEuler = new THREE.Euler();
const _doQ0 = new THREE.Quaternion();
const _doQ1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X
let _doAlpha = 0, _doBeta = 0, _doGamma = 0, _doOrient = 0;

function onDeviceOrientation(e) {
	_doAlpha = THREE.MathUtils.degToRad(e.alpha || 0);
	_doBeta = THREE.MathUtils.degToRad(e.beta || 0);
	_doGamma = THREE.MathUtils.degToRad(e.gamma || 0);
}
function onScreenOrientationChange() {
	_doOrient = (screen.orientation && typeof screen.orientation.angle === 'number')
		? THREE.MathUtils.degToRad(screen.orientation.angle)
		: 0;
}
function updateCameraFromDeviceOrientation() {
	_doEuler.set(_doBeta, _doAlpha, -_doGamma, 'YXZ');
	camera.quaternion.setFromEuler(_doEuler);
	camera.quaternion.multiply(_doQ1);
	camera.quaternion.multiply(_doQ0.setFromAxisAngle(_doZee, -_doOrient));
}

// iOS 13+ requires an explicit user-gesture-triggered permission prompt for
// motion/orientation events; every other platform just works.
async function requestDeviceOrientationPermission() {
	if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
		try {
			return (await DeviceOrientationEvent.requestPermission()) === 'granted';
		} catch (err) {
			console.error('Device orientation permission error:', err);
			return false;
		}
	}
	return true;
}

function ensureArPlacementMarker() {
	if (arPlacementMarker) return arPlacementMarker;
	const ring = new THREE.Mesh(
		new THREE.RingGeometry(0.28, 0.34, 48),
		new THREE.MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.55,
			side: THREE.DoubleSide,
			depthWrite: false
		})
	);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.01;
	ring.name = 'arPlacementMarker';
	ring.renderOrder = 5;
	arPlacementRoot.add(ring);
	arPlacementMarker = ring;
	return ring;
}

function isArUiTouchTarget(target) {
	if (!target || !target.closest) return false;
	return !!(
		target.closest('#mobile-xr-exit') ||
		target.closest('#mobile-xr-walk') ||
		target.closest('#mobile-xr-gizmo-bar') ||
		target.closest('#desktop-chat') ||
		target.closest('#files-picker-modal') ||
		target.closest('#export-modal') ||
		target.closest('#share-modal') ||
		target.closest('#rename-modal') ||
		target.closest('#XRButton') ||
		target.closest('#gs-dock') ||
		target.closest('.mobile-xr-btn')
	);
}

function raycastGround(clientX, clientY, out) {
	_arNdc.x = (clientX / window.innerWidth) * 2 - 1;
	_arNdc.y = -(clientY / window.innerHeight) * 2 + 1;
	_arRaycaster.setFromCamera(_arNdc, camera);
	return _arRaycaster.ray.intersectPlane(_arGroundPlane, out) !== null;
}

/** Parent for world content: AR placement root while Walk-in-AR is active. */
function getWorldContentParent() {
	return mobileXRMode === 'ar' ? arPlacementRoot : scene;
}

function gatherMovableSceneRoots() {
	const roots = [];
	for (const child of [...scene.children]) {
		if (child === player || child === arPlacementRoot) continue;
		if (arGizmoHelpers.includes(child)) continue;
		if (systemObjectIds.has(child.uuid)) continue;
		roots.push(child);
	}
	// Also pull any user content that somehow stayed under scene while marker/root exist
	return roots;
}

function adoptSceneContentIntoArPlacement() {
	for (const child of gatherMovableSceneRoots()) {
		arPlacementRoot.attach(child);
	}
}

function releaseArPlacementContentToScene() {
	for (const child of [...arPlacementRoot.children]) {
		if (child === arPlacementMarker) continue;
		scene.attach(child);
	}
}

function placeArAnchorInFrontOfCamera(distance = 1.6) {
	camera.getWorldPosition(_arCamPos);
	camera.getWorldDirection(_arFwd);
	_arFwd.y = 0;
	if (_arFwd.lengthSq() < 1e-6) _arFwd.set(0, 0, -1);
	_arFwd.normalize();
	arPlacementRoot.position.set(
		_arCamPos.x + _arFwd.x * distance,
		0,
		_arCamPos.z + _arFwd.z * distance
	);
	// Keep yaw so the scene faces the user
	arPlacementRoot.rotation.set(0, Math.atan2(_arFwd.x, _arFwd.z), 0);
}

function applyArGizmoAttachment() {
	for (const [mode, ctrl] of Object.entries(arTransformByMode)) {
		const helper = ctrl.getHelper();
		const want = arGizmoVisible && (arGizmoMode === 'all' || arGizmoMode === mode);
		if (want) {
			ctrl.attach(arPlacementRoot);
			ctrl.enabled = !arGizmoDragging || ctrl.dragging;
			ctrl.showX = true;
			ctrl.showY = true;
			ctrl.showZ = true;
			helper.visible = true;
		} else {
			ctrl.detach();
			ctrl.enabled = false;
			helper.visible = false;
		}
	}
}

function setArGizmoVisible(visible) {
	// Smartphones/tablets Walk-in-AR only — never in WebXR.
	if (renderer.xr.isPresenting || mobileXRMode !== 'ar') visible = false;
	arGizmoVisible = !!visible;
	if (!arGizmoVisible) arGizmoDragging = false;
	applyArGizmoAttachment();
	if (mobileXrGizmoToggle) {
		mobileXrGizmoToggle.textContent = arGizmoVisible ? 'Hide Gizmo' : 'Show Gizmo';
		mobileXrGizmoToggle.classList.toggle('active', arGizmoVisible);
	}
	if (mobileXrGizmoModes) mobileXrGizmoModes.classList.toggle('visible', arGizmoVisible);
}

function setArGizmoMode(mode) {
	const m = (mode === 'all' || mode === 'rotate' || mode === 'scale') ? mode : 'translate';
	arGizmoMode = m;
	applyArGizmoAttachment();
	for (const btn of [mobileXrGizmoAll, mobileXrGizmoTranslate, mobileXrGizmoRotate, mobileXrGizmoScale]) {
		if (!btn) continue;
		btn.classList.toggle('active', btn.dataset.mode === m);
	}
}

function setArPlacementActive(active) {
	ensureArPlacementMarker();
	if (arPlacementMarker) arPlacementMarker.visible = !!active;
	if (active) {
		adoptSceneContentIntoArPlacement();
		placeArAnchorInFrontOfCamera();
		// Touch must move the scene, never orbit/pan the camera (controls are
		// suspended while mobileXRMode is set).
		refreshCameraControls();
		renderer.domElement.style.touchAction = 'none';
		if (mobileXrGizmoBar) mobileXrGizmoBar.classList.add('visible');
		setArGizmoMode('all');
		setArGizmoVisible(true);
	} else {
		setArGizmoVisible(false);
		if (mobileXrGizmoBar) mobileXrGizmoBar.classList.remove('visible');
		releaseArPlacementContentToScene();
		arPlacementRoot.position.set(0, 0, 0);
		arPlacementRoot.rotation.set(0, 0, 0);
		arPlacementRoot.scale.set(1, 1, 1);
		arDragging = false;
		arDragPointerId = null;
		refreshCameraControls();
		renderer.domElement.style.touchAction = 'none';
	}
}

function onArPointerDown(e) {
	if (mobileXRMode !== 'ar' || renderer.xr.isPresenting) return;
	if (isArUiTouchTarget(e.target)) return;
	// When the transform gizmo is shown, placement goes through gizmo handles —
	// free ground drag is off so it doesn't fight axis grabs.
	if (arGizmoVisible || arGizmoDragging) return;
	if (!raycastGround(e.clientX, e.clientY, _arLastHit)) return;
	arDragging = true;
	arDragPointerId = e.pointerId;
	try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
	e.preventDefault();
}

function onArPointerMove(e) {
	if (!arDragging || mobileXRMode !== 'ar') return;
	if (arDragPointerId != null && e.pointerId !== arDragPointerId) return;
	if (!raycastGround(e.clientX, e.clientY, _arHit)) return;
	const dx = _arHit.x - _arLastHit.x;
	const dz = _arHit.z - _arLastHit.z;
	arPlacementRoot.position.x += dx;
	arPlacementRoot.position.z += dz;
	_arLastHit.copy(_arHit);
	e.preventDefault();
}

function onArPointerUp(e) {
	if (!arDragging) return;
	if (arDragPointerId != null && e.pointerId !== arDragPointerId) return;
	arDragging = false;
	arDragPointerId = null;
}

renderer.domElement.addEventListener('pointerdown', onArPointerDown, { passive: false });
renderer.domElement.addEventListener('pointermove', onArPointerMove, { passive: false });
renderer.domElement.addEventListener('pointerup', onArPointerUp);
renderer.domElement.addEventListener('pointercancel', onArPointerUp);
renderer.domElement.addEventListener('pointerleave', onArPointerUp);

async function enterMobileXRMode(mode) {
	// AR / Walk-in-AR entry removed. Cardboard only.
	if (mode !== 'cardboard') return;

	const granted = await requestDeviceOrientationPermission();
	if (!granted) {
		updateStatus('Motion access denied - needed to look around', 'error');
		return;
	}

	isVRMode = true;

	window.addEventListener('deviceorientation', onDeviceOrientation);
	window.addEventListener('orientationchange', onScreenOrientationChange);
	onScreenOrientationChange();

	try { await document.documentElement.requestFullscreen(); } catch { /* best-effort */ }
	if (screen.orientation && screen.orientation.lock) {
		try { await screen.orientation.lock('landscape'); } catch { /* not all browsers allow this */ }
	}

	mobileXRMode = 'cardboard';
	refreshCameraControls();
	document.body.classList.add('gs-cardboard-active');
	if (cardboardBtn) cardboardBtn.hidden = true;
	mobileXRExitBtn.hidden = false;
	raiseMobileXRExitButton();
	mobileXRWalkBtn.hidden = false;
	updateStatus('Cardboard VR active', 'connected');
	applyEnvironmentMode();
	applyLayDownView();
	renderDomEnv();
}

function exitMobileXRMode() {
	if (!mobileXRMode) return;

	window.removeEventListener('deviceorientation', onDeviceOrientation);
	window.removeEventListener('orientationchange', onScreenOrientationChange);

	if (arVideoStream) {
		for (const track of arVideoStream.getTracks()) track.stop();
		arVideoStream = null;
	}
	if (arVideoEl) {
		arVideoEl.classList.remove('active');
		arVideoEl.srcObject = null;
	}

	if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	if (screen.orientation && screen.orientation.unlock) {
		try { screen.orientation.unlock(); } catch { /* ignore */ }
	}

	const wasAr = mobileXRMode === 'ar';
	mobileXRMode = null;
	document.body.classList.remove('gs-cardboard-active');
	mobileMoveHeld = false;
	if (wasAr) setArPlacementActive(false);
	refreshCameraControls();
	resetCameraView(); // back to the default desktop view
	mobileXRExitBtn.hidden = true;
	mobileXRWalkBtn.hidden = true;
	isVRMode = true;
	applyEnvironmentMode();
	applyLayDownView(); // clear pitch for desktop
	renderDomEnv();
	updateStatus('Ready', '');
	refreshMobileXRButtons();
}

cardboardBtn.addEventListener('click', () => enterMobileXRMode('cardboard'));
mobileXRExitBtn.addEventListener('click', exitMobileXRMode);
raiseMobileXRExitButton();

// touchstart/touchend (mobile) and mousedown/mouseup (desktop testing) both
// wired so this works whether it's a real touchscreen or a mouse.
mobileXRWalkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); mobileMoveHeld = true; });
mobileXRWalkBtn.addEventListener('touchend', (e) => { e.preventDefault(); mobileMoveHeld = false; });
mobileXRWalkBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); mobileMoveHeld = false; });
mobileXRWalkBtn.addEventListener('mousedown', () => { mobileMoveHeld = true; });
mobileXRWalkBtn.addEventListener('mouseup', () => { mobileMoveHeld = false; });
mobileXRWalkBtn.addEventListener('mouseleave', () => { mobileMoveHeld = false; });

mobileXrGizmoToggle?.addEventListener('click', () => {
	if (mobileXRMode !== 'ar' || renderer.xr.isPresenting) return;
	setArGizmoVisible(!arGizmoVisible);
});
mobileXrGizmoAll?.addEventListener('click', () => setArGizmoMode('all'));
mobileXrGizmoTranslate?.addEventListener('click', () => setArGizmoMode('translate'));
mobileXrGizmoRotate?.addEventListener('click', () => setArGizmoMode('rotate'));
mobileXrGizmoScale?.addEventListener('click', () => setArGizmoMode('scale'));


// ============================================================================
// Lighting
// ============================================================================
// Named so AI scene code can find and dim them (see the photorealistic
// lighting section of SYSTEM_PROMPT in server.js).
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
ambientLight.name = 'gsDefaultAmbient';
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.name = 'gsDefaultKey';
directionalLight.position.set(0, 2, 1);
scene.add(directionalLight);

// VR skybox: large inverted sphere to block passthrough when in VR mode
const skyboxGeo = new THREE.SphereGeometry(50, 32, 16);
const skyboxMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x1a1a2e });
vrSkybox = new THREE.Mesh(skyboxGeo, skyboxMat);
vrSkybox.visible = false;
scene.add(vrSkybox);

// ============================================================================
// Chat Panel (3D Canvas Texture)
// ============================================================================
function createChatPanel() {
	// Create canvas for rendering text
	chatCanvas = document.createElement('canvas');
	chatCanvas.width = 1024;
	chatCanvas.height = 768;
	chatContext = chatCanvas.getContext('2d');

	// Create texture from canvas
	chatTexture = new THREE.CanvasTexture(chatCanvas);
	chatTexture.minFilter = THREE.LinearFilter;
	chatTexture.magFilter = THREE.LinearFilter;

	// Create panel geometry and material
	const geometry = new THREE.PlaneGeometry(CHAT_PANEL_WIDTH, CHAT_PANEL_HEIGHT);
	const material = new THREE.MeshBasicMaterial({
		map: chatTexture,
		transparent: true,
		side: THREE.DoubleSide
	});

	chatPanel = new THREE.Mesh(geometry, material);
	chatPanel.position.set(0, 1.4, -CHAT_PANEL_DISTANCE);
	scene.add(chatPanel);

	// Initial render
	renderChatToCanvas();
}

function renderChatToCanvas() {
	renderDomChat();
	if (!chatContext) return;

	const ctx = chatContext;
	const width = chatCanvas.width;
	const height = chatCanvas.height;
	const lineHeight = 36;
	const padding = 30;
	const maxWidth = width - padding * 2;
	const headerHeight = 60;
	const subTabY = headerHeight + 8;
	const subTabH = 36;
	const isTheme = chatSection === 'theme';
	const isPrompt = chatSection === 'prompt';
	chatThemeRememberBoxes = [];
	let themeRememberLayout = null;
	if (isPrompt) {
		// Chat → Prompt in a headset: read the prompt, reset it, or append a
		// line with the keyboard (full editing is on desktop / phone).
		const armed = performance.now() < vrPromptResetArmedUntil;
		themeRememberLayout = buildButtonLayout([{
			id: 'promptReset',
			label: armed ? 'Press again to reset' : (ChatPrompt.isCustom() ? 'Reset to default' : 'Default prompt (not edited)'),
			action: ChatPrompt.isCustom() ? 'prompt:reset' : 'noop',
			variant: armed ? 'active' : 'inactiveToggle'
		}], {
			width: width - 48,
			x: 24,
			y: subTabY + subTabH + 10,
			height: 36,
			perRow: 1,
			gap: 8
		});
		chatThemeRememberBoxes = themeRememberLayout.boxes;
	} else if (isTheme) {
		themeRememberLayout = buildButtonLayout([{
			id: 'rememberTheme',
			label: rememberTheme ? '\u2611 Remember theme' : '\u2610 Remember theme',
			action: 'theme:toggleRemember',
			variant: rememberTheme ? 'active' : 'inactiveToggle'
		}], {
			width: width - 48,
			x: 24,
			y: subTabY + subTabH + 10,
			height: 36,
			perRow: 1,
			gap: 8
		});
		chatThemeRememberBoxes = themeRememberLayout.boxes;
	}
	const contentTop = (isTheme || isPrompt)
		? (subTabY + subTabH + 10 + themeRememberLayout.totalHeight + 16)
		: (subTabY + subTabH + 28); // first line Y (below Scene|Theme tabs)
	const contentBottom = height - 20;
	const visibleLineCount = Math.floor((contentBottom - contentTop) / lineHeight);

	// Build all lines for the active chat section
	ctx.font = `${MESSAGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, sans-serif`;
	const allLines = []; // { text, color, font, heightScale }
	if (isPrompt) {
		allLines.push({
			text: ChatPrompt.isCustom() ? 'Custom prompt active' : 'Default Scene chat prompt',
			color: ChatPrompt.isCustom() ? '#fbbf24' : 'rgba(255,255,255,0.6)',
			font: `bold ${MESSAGE_FONT_SIZE - 6}px -apple-system, BlinkMacSystemFont, sans-serif`,
			heightScale: 0.8
		});
		allLines.push({
			text: 'Type and Send to add a line to the prompt. Edit fully on desktop or phone.',
			color: 'rgba(255,255,255,0.35)',
			font: `${MESSAGE_FONT_SIZE - 8}px -apple-system, BlinkMacSystemFont, sans-serif`,
			heightScale: 0.7
		});
		allLines.push({ text: '', color: '', font: '', heightScale: 0.4 });
		const promptText = ChatPrompt.currentText() || 'Loading…';
		const small = `${MESSAGE_FONT_SIZE - 6}px ui-monospace, Menlo, monospace`;
		ctx.font = small;
		for (const part of promptText.split('\n')) {
			for (const line of (part ? wrapText(ctx, part, maxWidth) : [''])) {
				allLines.push({ text: line, color: '#d1d5db', font: small, heightScale: 0.75 });
			}
		}
		ctx.font = `${MESSAGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, sans-serif`;
	} else if (isTheme) {
		allLines.push({
			text: 'Theme restyle chat',
			color: 'rgba(255,255,255,0.45)',
			font: `bold ${MESSAGE_FONT_SIZE - 6}px -apple-system, BlinkMacSystemFont, sans-serif`,
			heightScale: 0.8
		});
		allLines.push({
			text: 'Ask for editor chrome restyles. Upload from Community → Themes.',
			color: 'rgba(255,255,255,0.35)',
			font: `${MESSAGE_FONT_SIZE - 8}px -apple-system, BlinkMacSystemFont, sans-serif`,
			heightScale: 0.7
		});
		allLines.push({ text: '', color: '', font: '', heightScale: 0.4 });
		for (const msg of themeChatMessages) {
			const isUser = msg.role === 'user';
			allLines.push({
				text: isUser ? 'You' : 'Theme AI',
				color: isUser ? '#6366f1' : '#f59e0b',
				font: `bold ${MESSAGE_FONT_SIZE - 4}px -apple-system, BlinkMacSystemFont, sans-serif`,
				heightScale: 0.7
			});
			const wrapped = wrapText(ctx, String(msg.content || ''), maxWidth);
			for (const line of wrapped) {
				allLines.push({
					text: line,
					color: '#e0e0e0',
					font: `${MESSAGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, sans-serif`,
					heightScale: 1.0
				});
			}
			allLines.push({ text: '', color: '', font: '', heightScale: 0.5 });
		}
		if (themeChatLoading) {
			allLines.push({
				text: thinkingStatusText(),
				color: '#8b5cf6',
				font: `italic ${MESSAGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, sans-serif`,
				heightScale: 1.0
			});
		}
	} else {
		for (const msg of displayMessages) {
			const isUser = msg.role === 'user';
			// Restored creation history is labelled and tinted amber (also in a headset).
			allLines.push({
				text: msg.historyMarker ? 'Creation history' : (isUser ? 'You' : 'Claude') + (msg.history ? ' (history)' : ''),
				color: msg.history ? '#f59e0b' : (isUser ? '#6366f1' : '#10b981'),
				font: `bold ${MESSAGE_FONT_SIZE - 4}px -apple-system, BlinkMacSystemFont, sans-serif`,
				heightScale: 0.7
			});
			const wrapped = msg.history
				? String(msg.content || '').split('\n').flatMap(part => wrapText(ctx, part, maxWidth))
				: wrapText(ctx, msg.content, maxWidth);
			for (const line of wrapped) {
				allLines.push({
					text: line,
					color: msg.history ? '#c9c9c9' : '#e0e0e0',
					font: `${MESSAGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, sans-serif`,
					heightScale: 1.0
				});
			}
			allLines.push({ text: '', color: '', font: '', heightScale: 0.5 });
		}
		if (isLoading) {
			allLines.push({
				text: thinkingStatusText(),
				color: '#8b5cf6',
				font: `italic ${MESSAGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, sans-serif`,
				heightScale: 1.0
			});
		}
	}

	// Clamp scroll offset: 0 = bottom (newest visible), max = scrolled to top
	const totalLines = allLines.length;
	const maxScroll = Math.max(0, totalLines - visibleLineCount);
	chatScrollOffset = Math.max(0, Math.min(chatScrollOffset, maxScroll));

	const bottomIndex = totalLines - chatScrollOffset;
	const topIndex = Math.max(0, bottomIndex - visibleLineCount);

	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = 'rgba(20, 20, 30, 0.92)';
	roundRect(ctx, 0, 0, width, height, 24);
	ctx.fill();

	ctx.fillStyle = 'rgba(99, 102, 241, 0.3)';
	roundRect(ctx, 0, 0, width, headerHeight, 24, true);
	ctx.fill();

	ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.fillStyle = '#ffffff';
	ctx.textAlign = 'center';
	ctx.fillText(isPrompt ? 'Scene Chat Prompt' : (isTheme ? 'Theme Chat' : 'Claude Chat'), width / 2, 40);

	// Scene | Theme subtabs (match desktop Chat sections)
	const chatSubButtons = CHAT_SUB_TABS.map(t => ({
		...t,
		variant: chatSection === t.id ? 'active' : 'inactiveToggle'
	}));
	const chatSubLayout = buildButtonLayout(chatSubButtons, {
		width: width - 48, x: 24, y: subTabY, height: subTabH, perRow: CHAT_SUB_TABS.length, gap: 8
	});
	chatPanelSubTabBoxes = chatSubLayout.boxes;
	drawButtonsToCanvas(ctx, chatPanelSubTabBoxes, { fontSize: 16 });
	if (themeRememberLayout) drawButtonsToCanvas(ctx, chatThemeRememberBoxes, { fontSize: 16 });

	if (chatScrollOffset < maxScroll) {
		ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
		ctx.font = '18px sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('\u25B2 scroll up', width / 2, contentTop - 10);
	}

	ctx.textAlign = 'left';
	let y = contentTop;
	for (let i = topIndex; i < bottomIndex && i < totalLines; i++) {
		const line = allLines[i];
		if (!line.text) {
			y += lineHeight * line.heightScale;
			continue;
		}
		if (y > contentBottom) break;
		ctx.font = line.font;
		ctx.fillStyle = line.color;
		ctx.fillText(line.text, padding, y);
		y += lineHeight * line.heightScale;
	}

	if (chatScrollOffset > 0) {
		ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
		ctx.font = '18px sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('\u25BC scroll down', width / 2, height - 8);
		ctx.textAlign = 'left';
	}

	if (maxScroll > 0) {
		const trackX = width - 14;
		const trackTop = contentTop - 8;
		const trackHeight = height - trackTop - 8;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
		roundRect(ctx, trackX, trackTop, 8, trackHeight, 4);
		ctx.fill();
		const thumbRatio = visibleLineCount / Math.max(1, totalLines);
		const thumbHeight = Math.max(20, trackHeight * thumbRatio);
		const scrollRatio = maxScroll > 0 ? (maxScroll - chatScrollOffset) / maxScroll : 0;
		const thumbY = trackTop + scrollRatio * (trackHeight - thumbHeight);
		ctx.fillStyle = 'rgba(99, 102, 241, 0.5)';
		roundRect(ctx, trackX, thumbY, 8, thumbHeight, 4);
		ctx.fill();
	}

	chatTexture.needsUpdate = true;
}

// Renders the same message list into the desktop (non-XR) DOM chat window.
function renderDomChat() {
	if (!desktopChatMessages) return;

	desktopChatMessages.innerHTML = '';
	for (const msg of displayMessages) {
		const bubble = document.createElement('div');
		bubble.className = 'dchat-msg ' + (msg.role === 'user' ? 'user' : 'assistant');
		bubble.textContent = msg.content;
		if (msg.history) GSContext.decorateBubble(bubble, msg); // restored creation history
		desktopChatMessages.appendChild(bubble);
	}
	if (isLoading) {
		const thinking = document.createElement('div');
		thinking.className = 'dchat-msg thinking';
		thinking.textContent = thinkingStatusText();
		desktopChatMessages.appendChild(thinking);
	}
	desktopChatMessages.scrollTop = desktopChatMessages.scrollHeight;
}

function wrapText(ctx, text, maxWidth) {
	const words = text.split(' ');
	const lines = [];
	let currentLine = '';

	for (const word of words) {
		const testLine = currentLine + (currentLine ? ' ' : '') + word;
		const metrics = ctx.measureText(testLine);

		if (metrics.width > maxWidth && currentLine) {
			lines.push(currentLine);
			currentLine = word;
		} else {
			currentLine = testLine;
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines; // no line limit — full message displayed
}

function roundRect(ctx, x, y, w, h, r, topOnly = false) {
	ctx.beginPath();
	if (topOnly) {
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + w - r, y);
		ctx.quadraticCurveTo(x + w, y, x + w, y + r);
		ctx.lineTo(x + w, y + h);
		ctx.lineTo(x, y + h);
		ctx.lineTo(x, y + r);
		ctx.quadraticCurveTo(x, y, x + r, y);
	} else {
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + w - r, y);
		ctx.quadraticCurveTo(x + w, y, x + w, y + r);
		ctx.lineTo(x + w, y + h - r);
		ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
		ctx.lineTo(x + r, y + h);
		ctx.quadraticCurveTo(x, y + h, x, y + h - r);
		ctx.lineTo(x, y + r);
		ctx.quadraticCurveTo(x, y, x + r, y);
	}
	ctx.closePath();
}

// ============================================================================
// 3D Input Panel (for XR text input)
// ============================================================================
function createInputPanel() {
	inputCanvas = document.createElement('canvas');
	inputCanvas.width = 1024;
	inputCanvas.height = 128;
	inputContext = inputCanvas.getContext('2d');

	inputTexture = new THREE.CanvasTexture(inputCanvas);
	inputTexture.minFilter = THREE.LinearFilter;
	inputTexture.magFilter = THREE.LinearFilter;

	const geometry = new THREE.PlaneGeometry(INPUT_PANEL_WIDTH, INPUT_PANEL_HEIGHT);
	const material = new THREE.MeshBasicMaterial({
		map: inputTexture,
		transparent: true,
		side: THREE.DoubleSide
	});

	inputPanel = new THREE.Mesh(geometry, material);
	// Position below chat panel
	const inputY = 1.4 - CHAT_PANEL_HEIGHT / 2 - INPUT_PANEL_GAP - INPUT_PANEL_HEIGHT / 2;
	inputPanel.position.set(0, inputY, -CHAT_PANEL_DISTANCE);
	scene.add(inputPanel);

	renderInputToCanvas();
}

// Shared geometry for the input panel's buttons so rendering and hit-testing
// stay in sync. Layout, left to right: [input area][MIC][KEYS][Send].
function inputPanelLayout() {
	const W = inputCanvas ? inputCanvas.width : 1024;
	const H = inputCanvas ? inputCanvas.height : 128;
	const pad = 12, gap = 8;
	const sendW = 150, kbdW = 100, micW = 100;
	const sendX = W - pad - sendW;
	const kbdX = sendX - gap - kbdW;
	const micX = kbdX - gap - micW;
	const inputAreaX = pad;
	const inputAreaW = micX - gap - inputAreaX;
	return { W, H, pad, gap, sendW, kbdW, micW, sendX, kbdX, micX, inputAreaX, inputAreaW };
}

function renderInputToCanvas() {
	if (!inputContext) return;

	const ctx = inputContext;
	const width = inputCanvas.width;
	const height = inputCanvas.height;

	ctx.clearRect(0, 0, width, height);

	// Background
	ctx.fillStyle = 'rgba(30, 30, 40, 0.95)';
	roundRect(ctx, 0, 0, width, height, 20);
	ctx.fill();

	const L = inputPanelLayout();

	// Input area background
	ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
	roundRect(ctx, L.inputAreaX, 12, L.inputAreaW, height - 24, 12);
	ctx.fill();

	// Input text or placeholder
	ctx.font = '24px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.textAlign = 'left';
	if (inputText) {
		ctx.fillStyle = '#ffffff';
		let displayText = inputText;
		while (ctx.measureText(displayText + '|').width > L.inputAreaW - 32 && displayText.length > 0) {
			displayText = displayText.slice(1);
		}
		ctx.fillText(displayText + '|', L.inputAreaX + 12, height / 2 + 8);
	} else {
		ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
		let placeholder = 'Ask Claude something...';
		if (scenePanelSubTab === 'code') placeholder = 'KEYS edits Code — use Apply on left panel';
		else if (chatSection === 'theme') placeholder = 'Ask for a theme restyle...';
		else if (chatSection === 'prompt') placeholder = 'Add a line to the prompt...';
		ctx.fillText(placeholder, L.inputAreaX + 12, height / 2 + 8);
	}

	ctx.textAlign = 'center';
	ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, sans-serif';

	// Mic button — red while listening (always-on or push-to-talk)
	const micListening = micMode !== 'off';
	ctx.fillStyle = micListening ? '#ef4444' : 'rgba(90, 92, 120, 0.9)';
	roundRect(ctx, L.micX, 12, L.micW, height - 24, 12);
	ctx.fill();
	ctx.fillStyle = '#ffffff';
	ctx.fillText('MIC', L.micX + L.micW / 2, height / 2 + 8);

	// Keyboard show/hide button — indigo when the keyboard is showing
	ctx.fillStyle = keyboardCollapsed ? 'rgba(90, 92, 120, 0.9)' : '#6366f1';
	roundRect(ctx, L.kbdX, 12, L.kbdW, height - 24, 12);
	ctx.fill();
	ctx.fillStyle = '#ffffff';
	ctx.fillText('KEYS', L.kbdX + L.kbdW / 2, height / 2 + 8);

	// Send button
	const gradient = ctx.createLinearGradient(L.sendX, 0, L.sendX + L.sendW, height);
	gradient.addColorStop(0, '#6366f1');
	gradient.addColorStop(1, '#8b5cf6');
	ctx.fillStyle = gradient;
	roundRect(ctx, L.sendX, 12, L.sendW, height - 24, 12);
	ctx.fill();
	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.fillText('Send', L.sendX + L.sendW / 2, height / 2 + 8);
	ctx.textAlign = 'left';

	inputTexture.needsUpdate = true;
}

// ============================================================================
// 3D Virtual Keyboard (in-scene text entry for XR)
// ============================================================================
// Text is entered entirely in-scene: the controller raycast presses keys and we
// mutate `inputText` directly. We never focus the DOM input in XR, so the crashy
// Quest system keyboard is never summoned.
//
// Each row is laid out left-to-right; a key's `w` is a relative width weight. A
// plain string is a character key; an object declares a control key or a char key
// with a custom label.
const KB_ROWS_LETTERS = [
	['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
	['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
	['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
	[{ label: '⇧', action: 'shift', w: 1.5 }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', { label: '⌫', action: 'backspace', w: 1.5 }],
	[{ label: '?123', action: 'symbols', w: 2 }, { label: 'space', action: 'space', w: 5 }, '.', { label: 'Send', action: 'enter', w: 2 }]
];
const KB_ROWS_SYMBOLS = [
	['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
	['!', '@', '#', '$', '%', '&', '*', '(', ')', '/'],
	['-', '_', '=', '+', ':', ';', ',', '?', '\''],
	[{ label: '"', action: 'char' }, '[', ']', '{', '}', '<', '>', '~', { label: '⌫', action: 'backspace', w: 1.5 }],
	[{ label: 'abc', action: 'symbols', w: 2 }, { label: 'space', action: 'space', w: 5 }, '.', { label: 'Send', action: 'enter', w: 2 }]
];

function normalizeKey(key) {
	if (typeof key === 'string') {
		return { label: key, value: key, action: 'char', w: 1 };
	}
	return {
		label: key.label,
		value: key.value !== undefined ? key.value : key.label,
		action: key.action || 'char',
		w: key.w || 1
	};
}

function createKeyboardPanel() {
	keyboardCanvas = document.createElement('canvas');
	keyboardCanvas.width = 1024;
	keyboardCanvas.height = 384;
	keyboardContext = keyboardCanvas.getContext('2d');

	keyboardTexture = new THREE.CanvasTexture(keyboardCanvas);
	keyboardTexture.minFilter = THREE.LinearFilter;
	keyboardTexture.magFilter = THREE.LinearFilter;

	const geometry = new THREE.PlaneGeometry(KEYBOARD_PANEL_WIDTH, KEYBOARD_PANEL_HEIGHT);
	const material = new THREE.MeshBasicMaterial({
		map: keyboardTexture,
		transparent: true,
		side: THREE.DoubleSide
	});

	keyboardPanel = new THREE.Mesh(geometry, material);
	const inputY = 1.4 - CHAT_PANEL_HEIGHT / 2 - INPUT_PANEL_GAP - INPUT_PANEL_HEIGHT / 2;
	const kbY = inputY - INPUT_PANEL_HEIGHT / 2 - KEYBOARD_PANEL_GAP - KEYBOARD_PANEL_HEIGHT / 2;
	keyboardPanel.position.set(0, kbY, -CHAT_PANEL_DISTANCE);
	scene.add(keyboardPanel);

	renderKeyboardToCanvas();
}

function renderKeyboardToCanvas() {
	if (!keyboardContext) return;

	const ctx = keyboardContext;
	const W = keyboardCanvas.width;
	const H = keyboardCanvas.height;
	const pad = 12;
	const gap = 8;

	ctx.clearRect(0, 0, W, H);
	ctx.fillStyle = 'rgba(30, 30, 40, 0.95)';
	roundRect(ctx, 0, 0, W, H, 20);
	ctx.fill();

	const rows = keyboardSymbols ? KB_ROWS_SYMBOLS : KB_ROWS_LETTERS;
	keyboardKeyRects = [];

	const rowH = (H - pad * 2 - gap * (rows.length - 1)) / rows.length;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';

	for (let r = 0; r < rows.length; r++) {
		const keys = rows[r].map(normalizeKey);
		const totalWeight = keys.reduce((s, k) => s + k.w, 0);
		const usableW = W - pad * 2 - gap * (keys.length - 1);
		const unit = usableW / totalWeight;
		const y = pad + r * (rowH + gap);
		let x = pad;

		for (const k of keys) {
			const w = k.w * unit;
			const idx = keyboardKeyRects.length; // this key's index once pushed below

			// Key background: control keys get a solid tint, char keys a faint fill.
			if (k.action === 'enter') {
				const g = ctx.createLinearGradient(x, y, x + w, y + rowH);
				g.addColorStop(0, '#6366f1');
				g.addColorStop(1, '#8b5cf6');
				ctx.fillStyle = g;
			} else if (k.action === 'shift' && keyboardShift) {
				ctx.fillStyle = '#6366f1';
			} else if (k.action !== 'char' && k.action !== 'space') {
				ctx.fillStyle = 'rgba(90, 92, 120, 0.9)';
			} else {
				ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
			}
			roundRect(ctx, x, y, w, rowH, 10);
			ctx.fill();

			// Hover highlight: brighten the key the pointer is currently over.
			if (idx === keyboardHoverIndex) {
				ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
				roundRect(ctx, x, y, w, rowH, 10);
				ctx.fill();
				ctx.strokeStyle = '#ffffff';
				ctx.lineWidth = 3;
				roundRect(ctx, x + 1.5, y + 1.5, w - 3, rowH - 3, 9);
				ctx.stroke();
			}

			// Label
			ctx.fillStyle = '#ffffff';
			ctx.font = (k.action === 'enter' ? 'bold ' : '') + '30px -apple-system, BlinkMacSystemFont, sans-serif';
			let label = k.label;
			if (k.action === 'char' && keyboardShift && /^[a-z]$/.test(label)) {
				label = label.toUpperCase();
			}
			ctx.fillText(label, x + w / 2, y + rowH / 2 + 1);

			keyboardKeyRects.push({ x, y, w, h: rowH, value: k.value, action: k.action });
			x += w + gap;
		}
	}

	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';
	keyboardTexture.needsUpdate = true;
}

function keyIndexAtUV(uv) {
	const cx = uv.x * keyboardCanvas.width;
	const cy = (1 - uv.y) * keyboardCanvas.height; // UV y is flipped vs canvas y
	for (let i = 0; i < keyboardKeyRects.length; i++) {
		const r = keyboardKeyRects[i];
		if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return i;
	}
	return -1;
}

// Update which key is highlighted; only re-render the canvas when it changes.
function setKeyboardHover(index) {
	if (index === keyboardHoverIndex) return;
	keyboardHoverIndex = index;
	renderKeyboardToCanvas();
}

function handleKeyboardHit(uv) {
	const idx = keyIndexAtUV(uv);
	if (idx >= 0) dispatchKey(keyboardKeyRects[idx]);
}

function xrCodeEditingActive() {
	return scenePanelSubTab === 'code' && !!dchatCodeEditor;
}

function setCodeEditorText(text) {
	if (!dchatCodeEditor) return;
	dchatCodeEditor.value = text;
	codeHighlightApi?.refresh();
	markCodeEditorDirty();
	renderScenePanel();
}

function dispatchKey(key) {
	const htmlField = htmlInCanvasTextField();
	if (htmlField) {
		dispatchKeyToDomField(htmlField, key);
		tickHtmlInCanvas(true);
		return;
	}
	const editCode = xrCodeEditingActive();
	switch (key.action) {
		case 'char': {
			let c = key.value;
			if (keyboardShift && /^[a-z]$/.test(c)) c = c.toUpperCase();
			if (editCode) setCodeEditorText(dchatCodeEditor.value + c);
			else setInputText(inputText + c);
			// Shift auto-resets after one character, like a phone keyboard.
			if (keyboardShift) {
				keyboardShift = false;
				renderKeyboardToCanvas();
			}
			break;
		}
		case 'space':
			if (editCode) setCodeEditorText(dchatCodeEditor.value + ' ');
			else setInputText(inputText + ' ');
			break;
		case 'backspace':
			if (editCode) setCodeEditorText(dchatCodeEditor.value.slice(0, -1));
			else setInputText(inputText.slice(0, -1));
			break;
		case 'shift':
			keyboardShift = !keyboardShift;
			renderKeyboardToCanvas();
			break;
		case 'symbols':
			keyboardSymbols = !keyboardSymbols;
			keyboardShift = false;
			renderKeyboardToCanvas();
			break;
		case 'enter':
			if (editCode) setCodeEditorText(dchatCodeEditor.value + '\n');
			else handleXRSend();
			break;
	}
}

// Set the current input text and keep every representation of it in sync:
// the state var, the hidden DOM input (used by the desktop path), and the 3D
// input panel's rendered text.
function setInputText(text) {
	inputText = text;
	chatInput.value = text;
	renderInputToCanvas();
}

// Show/hide the in-scene keyboard. When collapsed it is removed from hit-testing
// (see the render loop) so the pointer passes through to whatever is behind it.
function toggleKeyboard() {
	keyboardCollapsed = !keyboardCollapsed;
	if (!keyboardCollapsed) htmlKeyboardForDom = true;
	if (keyboardCollapsed) {
		htmlKeyboardForDom = false;
		setKeyboardHover(-1);
	}
	applyXrPanelVisibility(xrSessionActive());
	layoutHtmlInCanvasPanel();
	renderInputToCanvas(); // refresh the KEYS button state
}

// ============================================================================
// Pointer Ray Visibility Toggle
// ============================================================================
// Hide the ray *lines* for an unobstructed view while keeping the intersection
// cursor (reticle) so the user can still aim. Bound to the B/Y controller button.
function toggleRayVisibility() {
	rayVisible = !rayVisible;
	for (const ray of controllerRays) {
		if (ray) ray.visible = rayVisible;
	}
	updateStatus(rayVisible ? 'Pointer lines on' : 'Pointer lines off (cursor only)', '');
}

// ============================================================================
// Speech-to-Text (cross-platform: MediaRecorder + in-browser Whisper)
// ============================================================================
// The Web Speech API (SpeechRecognition) only exists in Chrome/Edge desktop, so
// it was dead on the Quest Browser, Firefox, and Safari. Instead we capture audio
// with getUserMedia + MediaRecorder (supported everywhere) and transcribe it
// locally in the browser with Whisper via transformers.js — no API key, no server
// round-trip, works on any platform with a mic and a secure context.
//   • Always-on: toggle the MIC button; a voice-activity detector segments speech
//     and each finished utterance is transcribed and auto-sent.
//   • Push-to-talk: hold the A/X controller button; the utterance is transcribed
//     and sent on release.
// Requires a secure context (HTTPS or localhost) for mic access — the same
// requirement WebXR itself has — plus internet on first run to fetch the model.
const STT_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
const STT_MODEL = 'Xenova/whisper-tiny.en';
const VAD_RMS_THRESHOLD = 0.015; // speech vs. silence energy threshold
const VAD_SILENCE_MS = 800;      // trailing silence that ends an utterance

function initSpeech() {
	speechSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

// Lazily download + build the Whisper pipeline (cached in the browser after the
// first run). Returned promise is memoized; on failure it resets so we can retry.
function loadSttPipeline() {
	if (!sttPipelinePromise) {
		updateStatus('Loading speech model… (first time only)', '');
		sttPipelinePromise = import(/* @vite-ignore */ STT_CDN)
			.then(async ({ pipeline, env }) => {
				env.allowLocalModels = false; // fetch from the HF hub, not a local path
				const asr = await pipeline('automatic-speech-recognition', STT_MODEL);
				sttModelReady = true;
				return asr;
			})
			.catch((e) => {
				sttPipelinePromise = null; // allow a later retry
				throw e;
			});
	}
	return sttPipelinePromise;
}

async function ensureMicStream() {
	if (micStream) return micStream;
	micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
	return micStream;
}

// Decode an encoded audio blob (webm/ogg/mp4) to a mono 16 kHz Float32Array,
// which is what Whisper expects.
async function decodeTo16kMono(blob) {
	const AC = window.AudioContext || window.webkitAudioContext;
	const buf = await blob.arrayBuffer();
	const tmp = new AC();
	let decoded;
	try {
		decoded = await tmp.decodeAudioData(buf);
	} finally {
		tmp.close();
	}
	const rate = 16000;
	const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
	const src = offline.createBufferSource();
	src.buffer = decoded;
	src.connect(offline.destination);
	src.start(0);
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0);
}

async function transcribeBlob(blob) {
	if (!blob || blob.size < 1200) return ''; // effectively empty
	const asr = await loadSttPipeline();
	const audio = await decodeTo16kMono(blob);
	if (!audio || audio.length < 1600) return ''; // < ~0.1s
	const out = await asr(audio);
	return (out && out.text ? out.text : '').trim();
}

// One MediaRecorder utterance at a time.
function startUtterance() {
	recordedChunks = [];
	mediaRecorder = new MediaRecorder(micStream);
	mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
	mediaRecorder.start();
}

function stopUtterance() {
	return new Promise((resolve) => {
		if (!mediaRecorder || mediaRecorder.state === 'inactive') { resolve(null); return; }
		mediaRecorder.onstop = () => {
			const type = recordedChunks[0] ? recordedChunks[0].type : 'audio/webm';
			resolve(recordedChunks.length ? new Blob(recordedChunks, { type }) : null);
		};
		try { mediaRecorder.stop(); } catch (e) { resolve(null); }
	});
}

async function transcribeAndDeliver(blob, autoSend) {
	if (!blob) return;
	sttBusy = true;
	updateStatus('Transcribing…', '');
	try {
		const text = await transcribeBlob(blob);
		if (text) {
			setInputText(text);
			if (autoSend && !isLoading) handleXRSend();
			else updateStatus(micMode === 'always' ? 'Mic on — listening' : 'Transcribed', micMode === 'always' ? 'connected' : '');
		} else {
			updateStatus(micMode === 'always' ? 'Mic on — listening' : 'No speech detected', micMode === 'always' ? 'connected' : '');
		}
	} catch (e) {
		micError(e);
	} finally {
		sttBusy = false;
	}
}

function micError(e) {
	console.error('Speech error:', e);
	const name = e && e.name ? e.name : '';
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		updateStatus('Microphone blocked — allow mic access (needs HTTPS/localhost)', 'error');
	} else if (name === 'NotFoundError') {
		updateStatus('No microphone found', 'error');
	} else {
		updateStatus('Speech error: ' + (e && e.message ? e.message : name || 'unknown'), 'error');
	}
	renderInputToCanvas();
	updateMicButtonDOM();
}

// --- Voice-activity detection (always-on mode) ---
// IMPORTANT: this is pumped from the main XR animation loop (pumpVad), NOT from
// window.requestAnimationFrame — the latter does not fire during an immersive
// WebXR session, which is why always-on transcription was dead in MR.
function startVad() {
	const AC = window.AudioContext || window.webkitAudioContext;
	vadContext = new AC();
	const source = vadContext.createMediaStreamSource(micStream);
	vadAnalyser = vadContext.createAnalyser();
	vadAnalyser.fftSize = 1024;
	source.connect(vadAnalyser);
	vadData = new Float32Array(vadAnalyser.fftSize);
	vadSpeaking = false;
	vadSilenceMs = 0;
	vadLastTime = performance.now();
}

// One VAD step. Called every frame from renderer.setAnimationLoop so it runs in
// both the windowed view and immersive MR.
function pumpVad() {
	if (micMode !== 'always' || !vadAnalyser) return;
	vadAnalyser.getFloatTimeDomainData(vadData);
	let sum = 0;
	for (let i = 0; i < vadData.length; i++) sum += vadData[i] * vadData[i];
	const rms = Math.sqrt(sum / vadData.length);
	const now = performance.now();
	const dt = now - vadLastTime;
	vadLastTime = now;
	if (rms > VAD_RMS_THRESHOLD) {
		vadSpeaking = true;
		vadSilenceMs = 0;
	} else if (vadSpeaking) {
		vadSilenceMs += dt;
		if (vadSilenceMs >= VAD_SILENCE_MS && !sttBusy) {
			segmentUtterance();
		}
	}
}

function stopVad() {
	if (vadContext) { try { vadContext.close(); } catch (e) { /* ignore */ } vadContext = null; }
	vadAnalyser = null;
	vadData = null;
	vadSpeaking = false;
	vadSilenceMs = 0;
}

// End the current utterance, immediately begin capturing the next, and transcribe
// the finished one in the background.
async function segmentUtterance() {
	sttBusy = true; // close the race with the next VAD tick until transcription starts
	vadSpeaking = false;
	vadSilenceMs = 0;
	const blob = await stopUtterance();
	if (micMode === 'always') startUtterance();
	await transcribeAndDeliver(blob, true);
}

// Always-on listening toggle (MIC button + DOM button).
async function toggleMicAlwaysOn() {
	if (!speechSupported) {
		updateStatus('Microphone not available on this device', 'error');
		return;
	}
	if (micMode === 'always') { stopAlwaysOn(); return; }
	if (micMode === 'ptt') return; // let a push-to-talk finish first
	micMode = 'always';
	renderInputToCanvas();
	updateMicButtonDOM();
	updateStatus(sttModelReady ? 'Mic on — listening' : 'Loading speech model…', 'connected');
	try {
		await ensureMicStream();
		loadSttPipeline(); // warm the model in the background
		if (micMode !== 'always') return; // toggled off during setup
		startVad();
		startUtterance();
		updateStatus('Mic on — listening', 'connected');
	} catch (e) {
		micMode = 'off';
		renderInputToCanvas();
		updateMicButtonDOM();
		micError(e);
	}
}

function stopAlwaysOn() {
	micMode = 'off';
	stopVad();
	if (mediaRecorder && mediaRecorder.state !== 'inactive') {
		try { mediaRecorder.stop(); } catch (e) { /* ignore */ }
	}
	renderInputToCanvas();
	updateMicButtonDOM();
	updateStatus('Mic off', '');
}

// Push-to-talk (controller A/X button). Only engages when always-on is off.
async function startPTT(hand) {
	if (!speechSupported) {
		updateStatus('Microphone not available on this device', 'error');
		return;
	}
	if (micMode !== 'off') return; // busy: already listening (always-on or PTT)
	micMode = 'ptt';
	pttHand = hand;
	renderInputToCanvas();
	updateMicButtonDOM();
	updateStatus(sttModelReady ? 'Listening… (push-to-talk)' : 'Loading speech model…', '');
	try {
		await ensureMicStream();
		if (micMode !== 'ptt') return; // released during setup
		startUtterance();          // capture immediately…
		loadSttPipeline();          // …while the model warms in the background
		updateStatus('Listening… (push-to-talk)', '');
	} catch (e) {
		micMode = 'off';
		pttHand = null;
		micError(e);
	}
}

async function stopPTT(hand) {
	if (micMode !== 'ptt' || hand !== pttHand) return;
	micMode = 'off';
	pttHand = null;
	renderInputToCanvas();
	updateMicButtonDOM();
	const blob = await stopUtterance();
	await transcribeAndDeliver(blob, true);
}

function updateMicButtonDOM() {
	const listening = micMode !== 'off';
	const btn = document.getElementById('mic-button');
	if (btn) btn.classList.toggle('listening', listening);
	if (desktopMicButton) desktopMicButton.classList.toggle('listening', listening);
}

// ============================================================================
// Side Panel (VR environment + Color Wheel)
// ============================================================================
function createSidePanel() {
	sideCanvas = document.createElement('canvas');
	sideCanvas.width = 256;
	sideCanvas.height = 768;
	sideContext = sideCanvas.getContext('2d');

	sideTexture = new THREE.CanvasTexture(sideCanvas);
	sideTexture.minFilter = THREE.LinearFilter;
	sideTexture.magFilter = THREE.LinearFilter;

	const geometry = new THREE.PlaneGeometry(SIDE_PANEL_WIDTH, SIDE_PANEL_HEIGHT);
	const material = new THREE.MeshBasicMaterial({
		map: sideTexture,
		transparent: true,
		side: THREE.DoubleSide
	});

	sidePanel = new THREE.Mesh(geometry, material);
	// Position to the right of the chat panel
	const sideX = CHAT_PANEL_WIDTH / 2 + SIDE_PANEL_GAP + SIDE_PANEL_WIDTH / 2;
	sidePanel.position.set(sideX, 1.4, -CHAT_PANEL_DISTANCE);
	scene.add(sidePanel);

	renderSidePanel();
}

function hslToRgbString(h, s, l) {
	return `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

function hslToHex(h, s, l) {
	const c = new THREE.Color();
	c.setHSL(h / 360, s, l);
	return '#' + c.getHexString();
}

// Mirrors the VR + color/brightness controls (canvas side panel, VR-only)
// into the desktop Environment tab. Safe to call before the desktop DOM
// exists (e.g. not yet — guarded by null checks below).
function renderDomEnv() {
	if (!dchatEnvModeMount) return;
	const buttons = [
		...ENV_MODE_BUTTONS.map(b => ({
			...b,
			variant: (b.id === 'ar' && !isVRMode) || (b.id === 'vr' && isVRMode) ? 'active' : 'inactiveToggle'
		})),
		getLayDownButton()
	];
	mountButtonsToDOM(dchatEnvModeMount, buttons, { width: 256, height: 40, gap: 6, fontSize: 13, perRow: 2 }, handleMenuAction);
	const colorEnabled = envColorControlsEnabled();
	if (dchatEnvControls) dchatEnvControls.classList.toggle('disabled', !colorEnabled);
	const note = dchatEnvControls && dchatEnvControls.querySelector('.dchat-disabled-note');
	if (note) {
		note.style.display = colorEnabled ? 'none' : '';
		note.textContent = colorEnabled
			? ''
			: 'Background color is unavailable while a VR session is active.';
	}
	const hex = hslToHex(vrBgHue, vrBgSat, vrBgLight);
	if (dchatColorPicker) dchatColorPicker.value = hex;
	if (dchatColorPreview) dchatColorPreview.style.background = hex;
	if (dchatBrightness) dchatBrightness.value = Math.round(vrBgLight * 100);
}

/** Color picker is for desktop / mobile browser viewing — not while an AR/VR session is active. */
function envColorControlsEnabled() {
	if (typeof mobileXRMode !== 'undefined' && mobileXRMode) return false;
	if (renderer && renderer.xr && renderer.xr.isPresenting) return false;
	return true;
}

function renderSidePanel() {
	renderDomEnv();
	if (!sideContext) return;

	const ctx = sideContext;
	const w = sideCanvas.width;
	const h = sideCanvas.height;

	ctx.clearRect(0, 0, w, h);

	// Background
	ctx.fillStyle = 'rgba(20, 20, 30, 0.92)';
	roundRect(ctx, 0, 0, w, h, 16);
	ctx.fill();

	// Header — matches desktop Environment tab title
	ctx.fillStyle = 'rgba(99, 102, 241, 0.3)';
	roundRect(ctx, 0, 0, w, 40, 16, true);
	ctx.fill();
	ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.fillStyle = '#ffffff';
	ctx.textAlign = 'center';
	ctx.fillText('Environment', w / 2, 28);

	// --- VR mode (shared spec - see ENV_MODE_BUTTONS/handleMenuAction) ---
	const envButtons = ENV_MODE_BUTTONS.map(b => ({
		...b,
		variant: (b.id === 'ar' && !isVRMode) || (b.id === 'vr' && isVRMode) ? 'active' : 'inactiveToggle'
	}));
	const envLayout = buildButtonLayout(envButtons, { width: w - 32, x: 16, y: 48, height: 44, perRow: 2, gap: 4 });
	sidePanelEnvButtonBoxes = envLayout.boxes;
	drawButtonsToCanvas(ctx, sidePanelEnvButtonBoxes, { fontSize: 14 });

	// Exit VR + Lay down / Sit up (XR-only; desktop has no immersive session)
	const exitY = 48 + envLayout.totalHeight + 6;
	const exitLayButtons = [...EXIT_XR_BUTTON, getLayDownButton()];
	const exitLayout = buildButtonLayout(exitLayButtons, { width: w - 32, x: 16, y: exitY, height: 34, perRow: 2, gap: 4 });
	sidePanelExitButtonBoxes = exitLayout.boxes;
	drawButtonsToCanvas(ctx, sidePanelExitButtonBoxes, { fontSize: 13 });

	// Live mirror of the desktop #desktop-chat element (off = canvas panels).
	const htmlY = exitY + exitLayout.totalHeight + 6;
	const htmlLayout = buildButtonLayout([getHtmlInCanvasButton()], {
		width: w - 32, x: 16, y: htmlY, height: 36, perRow: 1, gap: 4
	});
	// Windows: Fixed (stay put in the world) / Follow head (lazy follow).
	const anchorY = htmlY + htmlLayout.totalHeight + 4;
	const anchorLayout = buildButtonLayout([getWindowAnchorButton()], {
		width: w - 32, x: 16, y: anchorY, height: 32, perRow: 1, gap: 4
	});
	sidePanelHtmlButtonBoxes = htmlLayout.boxes.concat(anchorLayout.boxes);
	drawButtonsToCanvas(ctx, sidePanelHtmlButtonBoxes, { fontSize: 12 });

	// Navigation — same choices as desktop Environment → Navigation
	const navY = anchorY + anchorLayout.totalHeight + 6;
	ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.fillStyle = 'rgba(255,255,255,0.4)';
	ctx.textAlign = 'center';
	ctx.fillText('Navigation', w / 2, navY + 12);
	const navButtons = NAV_MODE_BUTTONS.map(b => ({
		...b,
		variant: (b.action === 'env:nav:free' && locomotionMode === 'free')
			|| (b.action === 'env:nav:planar' && locomotionMode === 'planar')
			? 'active' : 'inactiveToggle'
	}));
	const navLayout = buildButtonLayout(navButtons, { width: w - 32, x: 16, y: navY + 18, height: 32, perRow: 2, gap: 4 });
	sidePanelNavButtonBoxes = navLayout.boxes;
	drawButtonsToCanvas(ctx, sidePanelNavButtonBoxes, { fontSize: 12 });

	const controlsTop = navY + 18 + navLayout.totalHeight + 10;

	// --- Section label ---
	ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.fillStyle = 'rgba(255,255,255,0.4)';
	ctx.textAlign = 'center';
	ctx.fillText('Background Color', w / 2, controlsTop + 14);

	// --- Color Wheel (below nav; keep radius so it still fits) ---
	const wheelCX = w / 2;
	const wheelCY = controlsTop + 120;
	const wheelR = 88;
	const wheelInnerR = 18;
	sidePanelWheelHit = { cx: wheelCX, cy: wheelCY, r: wheelR, innerR: wheelInnerR };

	// Draw color wheel using arc segments
	for (let angle = 0; angle < 360; angle += 1) {
		const startRad = (angle - 1) * Math.PI / 180;
		const endRad = (angle + 1) * Math.PI / 180;

		// Gradient from white center to full saturation at edge
		const grad = ctx.createRadialGradient(wheelCX, wheelCY, wheelInnerR, wheelCX, wheelCY, wheelR);
		grad.addColorStop(0, hslToRgbString(angle, 0.0, 0.85));
		grad.addColorStop(0.5, hslToRgbString(angle, 0.6, 0.5));
		grad.addColorStop(1, hslToRgbString(angle, 1.0, 0.45));

		ctx.beginPath();
		ctx.moveTo(wheelCX, wheelCY);
		ctx.arc(wheelCX, wheelCY, wheelR, startRad, endRad);
		ctx.closePath();
		ctx.fillStyle = grad;
		ctx.fill();
	}

	// Dark center dot
	ctx.beginPath();
	ctx.arc(wheelCX, wheelCY, wheelInnerR - 2, 0, Math.PI * 2);
	ctx.fillStyle = 'rgba(20, 20, 30, 0.9)';
	ctx.fill();

	// Selection indicator on the wheel
	const selAngle = vrBgHue * Math.PI / 180;
	const selDist = wheelInnerR + vrBgSat * (wheelR - wheelInnerR);
	const selX = wheelCX + Math.cos(selAngle) * selDist;
	const selY = wheelCY + Math.sin(selAngle) * selDist;

	ctx.beginPath();
	ctx.arc(selX, selY, 8, 0, Math.PI * 2);
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 3;
	ctx.stroke();
	ctx.beginPath();
	ctx.arc(selX, selY, 8, 0, Math.PI * 2);
	ctx.strokeStyle = '#000000';
	ctx.lineWidth = 1;
	ctx.stroke();

	// --- Brightness Slider (below wheel) ---
	const sliderY = wheelCY + wheelR + 28;
	const sliderH = 28;
	const sliderPad = 24;
	const sliderW = w - sliderPad * 2;
	sidePanelSliderHit = { y: sliderY, h: sliderH, pad: sliderPad };

	ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.fillStyle = 'rgba(255,255,255,0.4)';
	ctx.textAlign = 'center';
	ctx.fillText('Brightness', w / 2, sliderY - 8);

	// Slider track gradient: black to current hue full bright
	const sliderGrad = ctx.createLinearGradient(sliderPad, 0, sliderPad + sliderW, 0);
	sliderGrad.addColorStop(0, hslToRgbString(vrBgHue, vrBgSat, 0.02));
	sliderGrad.addColorStop(0.5, hslToRgbString(vrBgHue, vrBgSat, 0.5));
	sliderGrad.addColorStop(1, hslToRgbString(vrBgHue, vrBgSat, 0.95));
	ctx.fillStyle = sliderGrad;
	roundRect(ctx, sliderPad, sliderY, sliderW, sliderH, 8);
	ctx.fill();

	// Slider thumb
	const thumbX = sliderPad + vrBgLight * sliderW;
	ctx.beginPath();
	ctx.arc(thumbX, sliderY + sliderH / 2, 12, 0, Math.PI * 2);
	ctx.fillStyle = hslToRgbString(vrBgHue, vrBgSat, vrBgLight);
	ctx.fill();
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 2;
	ctx.stroke();

	// --- Color Preview ---
	const prevY = sliderY + sliderH + 18;
	const prevH = 44;
	ctx.fillStyle = hslToRgbString(vrBgHue, vrBgSat, vrBgLight);
	roundRect(ctx, sliderPad, prevY, sliderW, prevH, 10);
	ctx.fill();

	// Label
	ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.fillStyle = vrBgLight > 0.5 ? '#000000' : '#ffffff';
	ctx.textAlign = 'center';
	ctx.fillText('Preview', w / 2, prevY + prevH / 2 + 6);

	// Dim overlay if in AR mode (color wheel inactive)
	if (!isVRMode) {
		ctx.fillStyle = 'rgba(20, 20, 30, 0.6)';
		const dimTop = controlsTop;
		roundRect(ctx, 0, dimTop, w, h - dimTop - 8, 0);
		ctx.fill();
		ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
		ctx.fillStyle = 'rgba(255,255,255,0.5)';
		ctx.textAlign = 'center';
		ctx.fillText('Switch to VR', w / 2, wheelCY);
		ctx.fillText('to customize', w / 2, wheelCY + 22);
	}

	ctx.textAlign = 'left';
	sideTexture.needsUpdate = true;
}

function applyEnvironmentMode() {
	const color = new THREE.Color();
	color.setHSL(vrBgHue / 360, vrBgSat, vrBgLight);

	const inMobileXR = typeof mobileXRMode !== 'undefined' && !!mobileXRMode;
	const inWebXR = !!(renderer && renderer.xr && renderer.xr.isPresenting);

	// Active equirect HDRI as background wins over solid color / skybox.
	if (hdriEquirect && hdriUseAsBackground) {
		scene.background = hdriEquirect;
		if (vrSkybox) vrSkybox.visible = false;
		if (!inWebXR && !inMobileXR) renderer.setClearColor(0x000000, 1);
		else renderer.setClearColor(0x000000, 0.0);
		return;
	}

	// Desktop / mobile browser (not in an XR session): solid scene background
	// so Environment tab color changes are visible immediately.
	if (!inWebXR && !inMobileXR) {
		scene.background = color.clone();
		if (vrSkybox) vrSkybox.visible = false;
		renderer.setClearColor(color, 1);
		return;
	}

	// Immersive VR / Cardboard: colored skybox.
	if (vrSkybox) {
		vrSkybox.material.color.copy(color);
		vrSkybox.visible = true;
	}
	scene.background = null;
	renderer.setClearColor(0x000000, 0.0);
}

function handleSidePanelHit(uv) {
	const canvasX = uv.x * 256;
	const canvasY = (1 - uv.y) * 768; // UV y is flipped vs canvas y

	// VR mode (shared spec - see ENV_MODE_BUTTONS/handleMenuAction)
	const envHit = hitTestButtons(sidePanelEnvButtonBoxes, canvasX, canvasY);
	if (envHit) {
		handleMenuAction(envHit.action);
		return;
	}

	const exitHit = hitTestButtons(sidePanelExitButtonBoxes, canvasX, canvasY);
	if (exitHit) {
		handleMenuAction(exitHit.action);
		return;
	}

	const htmlHit = hitTestButtons(sidePanelHtmlButtonBoxes, canvasX, canvasY);
	if (htmlHit) {
		handleMenuAction(htmlHit.action);
		return;
	}

	const navHit = hitTestButtons(sidePanelNavButtonBoxes, canvasX, canvasY);
	if (navHit) {
		handleMenuAction(navHit.action);
		return;
	}

	// Only handle color controls in VR mode
	if (!isVRMode) return;

	const wheelCX = sidePanelWheelHit.cx;
	const wheelCY = sidePanelWheelHit.cy;
	const wheelR = sidePanelWheelHit.r;
	const wheelInnerR = sidePanelWheelHit.innerR;
	const dx = canvasX - wheelCX;
	const dy = canvasY - wheelCY;
	const dist = Math.sqrt(dx * dx + dy * dy);

	if (dist <= wheelR && dist >= wheelInnerR) {
		vrBgHue = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
		vrBgSat = Math.max(0, Math.min(1, (dist - wheelInnerR) / (wheelR - wheelInnerR)));
		applyEnvironmentMode();
		renderSidePanel();
		return;
	}

	const sliderY = sidePanelSliderHit.y;
	const sliderH = sidePanelSliderHit.h;
	const sliderPad = sidePanelSliderHit.pad;
	if (canvasY >= sliderY - 10 && canvasY <= sliderY + sliderH + 10) {
		const sliderW = 256 - sliderPad * 2;
		vrBgLight = Math.max(0.02, Math.min(0.95, (canvasX - sliderPad) / sliderW));
		applyEnvironmentMode();
		renderSidePanel();
		return;
	}
}

// ============================================================================
// Scene Manager
// ============================================================================
const fileInput = document.getElementById('scene-file-input');
const folderInput = document.getElementById('scene-folder-input');
const exportModal = document.getElementById('export-modal');
const exportNameInput = document.getElementById('export-name');
const exportExtInput = document.getElementById('export-ext');
const exportPreview = document.getElementById('export-preview');
const exportScreenshotBtn = document.getElementById('export-screenshot-btn');
const exportCancelBtn = document.getElementById('export-cancel-btn');
const exportConfirmBtn = document.getElementById('export-confirm-btn');
const exportDownloadBtn = document.getElementById('export-download-btn');

let pendingExportThumbnail = null;
let pendingExportCombined = false;

// GLB / FBX export (exporter.js). Roots = everything clearUserObjects would
// remove: user content under the scene root and the Walk-in-AR placement group.
const sceneModelExport = initSceneExport({
	getRoots: () => {
		const roots = scene.children.filter((c) => !systemObjectIds.has(c.uuid) && c !== player && c !== arPlacementRoot);
		if (typeof arPlacementRoot !== 'undefined' && arPlacementRoot) {
			for (const c of arPlacementRoot.children) {
				if (c !== arPlacementMarker && !systemObjectIds.has(c.uuid)) roots.push(c);
			}
		}
		return roots;
	},
	getSceneName: () => loadedScenes.filter((sc) => sc.active).map((sc) => sc.name).filter(Boolean).join(' + ') || 'GS scene',
	notify: (text, kind) => updateStatus(text, kind),
	isImmersive: () => renderer.xr.isPresenting
});
window.gsSceneExport = sceneModelExport;
sceneModelExport.mountShareTab(document.getElementById('dchat-share'), { onShareLink: () => shareCurrentScene() });

function snapshotSystemObjects() {
	systemObjectIds.clear();
	scene.traverse(obj => systemObjectIds.add(obj.uuid));
	for (const helper of arGizmoHelpers) {
		helper.traverse(obj => systemObjectIds.add(obj.uuid));
	}
	systemOverlayIds.clear();
	const overlay = document.getElementById('overlay-root');
	for (const child of overlay.children) {
		if (child.id) systemOverlayIds.add(child.id);
	}
}

function captureScreenshot() {
	const size = 256;
	const rt = new THREE.WebGLRenderTarget(size, size);
	renderer.setRenderTarget(rt);
	renderer.render(scene, camera);
	renderer.setRenderTarget(null);

	const pixels = new Uint8Array(size * size * 4);
	renderer.readRenderTargetPixels(rt, 0, 0, size, size, pixels);

	const cvs = document.createElement('canvas');
	cvs.width = size;
	cvs.height = size;
	const c = cvs.getContext('2d');
	const imgData = c.createImageData(size, size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const src = ((size - 1 - y) * size + x) * 4;
			const dst = (y * size + x) * 4;
			imgData.data[dst] = pixels[src];
			imgData.data[dst + 1] = pixels[src + 1];
			imgData.data[dst + 2] = pixels[src + 2];
			imgData.data[dst + 3] = 255;
		}
	}
	c.putImageData(imgData, 0, 0);
	rt.dispose();
	return cvs.toDataURL('image/jpeg', 0.7);
}

function disposeRecursive(obj) {
	if (obj.geometry) obj.geometry.dispose();
	if (obj.material) {
		if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
		else obj.material.dispose();
	}
	for (const child of [...obj.children]) {
		disposeRecursive(child);
	}
}


// ============================================================================
// Code tab — view/edit generated VR program (active scenes + session blocks)
// ============================================================================
function setCodeEditorStatus(text, kind) {
	if (!dchatCodeStatus) return;
	dchatCodeStatus.textContent = text || '';
	dchatCodeStatus.className = kind || '';
}

function buildCodeEditorSource() {
	const chunks = [];
	for (const sc of loadedScenes) {
		if (!sc.active) continue;
		(sc.codeBlocks || []).forEach((code, i) => {
			const name = String(sc.name || 'Scene').replace(/\n/g, ' ');
			chunks.push(`// --- scene[${sc.id}] #${i} ${name} ---\n${String(code).trim()}`);
		});
	}
	executedCodeBlocks.forEach((code, i) => {
		chunks.push(`// --- block ${i} ---\n${String(code).trim()}`);
	});
	return chunks.join('\n\n');
}

function parseCodeEditorSource(text) {
	const sceneUpdates = new Map(); // sceneId -> code[]
	const sessionBlocks = [];
	const trimmed = (text || '').trim();
	if (!trimmed) return { sceneUpdates, sessionBlocks };

	const parts = trimmed.split(/(?=^\/\/ --- .+? ---$)/m);
	for (const part of parts) {
		const m = part.match(/^\/\/ --- (.+?) ---\r?\n?([\s\S]*)$/);
		if (!m) {
			const orphan = part.trim();
			if (orphan) sessionBlocks.push(orphan);
			continue;
		}
		const label = m[1].trim();
		const code = (m[2] || '').trim();
		if (!code) continue;
		const sceneMatch = label.match(/^scene\[([^\]]+)\]/);
		if (sceneMatch) {
			const id = sceneMatch[1];
			if (!sceneUpdates.has(id)) sceneUpdates.set(id, []);
			sceneUpdates.get(id).push(code);
		} else {
			sessionBlocks.push(code);
		}
	}
	return { sceneUpdates, sessionBlocks };
}

function sceneBlockKey(sc, i) { return `scene:${sc.id}#${i}`; }
function sessionBlockKey(i) { return `block:${i}`; }

/** Editor text -> ordered [{key, code, sceneId}] using the // --- markers. */
function parseCodeEditorBlocks(text) {
	const { sceneUpdates, sessionBlocks } = parseCodeEditorSource(text);
	const blocks = [];
	for (const sc of loadedScenes) {
		if (!sc.active) continue;
		const codes = sceneUpdates.has(sc.id) ? sceneUpdates.get(sc.id) : (sc.codeBlocks || []);
		codes.forEach((code, i) => blocks.push({ key: sceneBlockKey(sc, i), code, sceneId: sc.id }));
	}
	sessionBlocks.forEach((code, i) => blocks.push({ key: sessionBlockKey(i), code, sceneId: null }));
	return { blocks, sceneUpdates, sessionBlocks };
}

function blockLabel(key) {
	return key.startsWith('block:') ? `block ${key.slice(6)}` : `scene block ${key.split('#')[1] || ''}`.trim();
}

/**
 * Hot reload: re-run only the blocks whose code changed and keep the rest of
 * the world running. Objects a changed block made are snapshotted (position,
 * rotation, scale, userData.velocity, ammo body velocity) by name, torn down
 * with that block's callbacks/timers/listeners, and restored onto the new
 * objects with the same names. gs.state / window.gsState are untouched.
 * A syntax error changes nothing; a runtime error rolls that block back to
 * its last working code. Only if the rollback fails too does it fall back to
 * a full clear-and-re-run.
 */
async function hotReloadFromEditor({ fromLive = false } = {}) {
	if (!dchatCodeEditor || codeEditorApplying) return;
	codeEditorApplying = true;
	if (dchatCodeApply) dchatCodeApply.disabled = true;
	const text = dchatCodeEditor.value;
	try {
		const { blocks, sceneUpdates, sessionBlocks } = parseCodeEditorBlocks(text);
		const wanted = new Map(blocks.map((b) => [b.key, b]));
		const changed = [];
		for (const b of blocks) {
			const rt = _blockRuntimes.get(b.key);
			if (!rt || rt.code.trim() !== b.code.trim()) changed.push(b);
		}
		const removed = [..._blockRuntimes.values()].filter((rt) => !rt.key.startsWith('adhoc:') && !wanted.has(rt.key));
		if (!changed.length && !removed.length) {
			codeEditorDirty = false;
			setCodeEditorStatus('Hot reload: no code changes', 'ok');
			return;
		}
		// 1. Compile every changed block first: a typo must not touch the scene.
		const compiled = new Map();
		for (const b of changed) {
			try {
				compiled.set(b.key, compileVrBlock(b.code));
			} catch (err) {
				codeEditorDirty = true;
				setCodeEditorStatus(`Syntax error in ${blockLabel(b.key)}: ${err.message} (scene unchanged)`, 'error');
				return;
			}
		}
		setCodeEditorStatus(fromLive ? 'Hot reloading…' : 'Applying (hot reload)…', 'pending');
		// 2. Commit the new code to the model.
		for (const [id, codes] of sceneUpdates) {
			const sc = loadedScenes.find((x) => x.id === id);
			if (sc) sc.codeBlocks = codes;
		}
		executedCodeBlocks = sessionBlocks;
		// 3. Drop blocks that were deleted from the editor.
		for (const rt of removed) teardownBlock(rt);
		// 4. Swap each changed block in place.
		const errors = [];
		let restoredCount = 0;
		for (const b of changed) {
			const old = _blockRuntimes.get(b.key) || null;
			const snap = old ? snapshotBlockState(old) : null;
			if (old) teardownBlock(old);
			try {
				const rt = await runTrackedBlock(b.code, b.key, { hot: true, compiled: compiled.get(b.key) });
				restoredCount += restoreBlockState(snap, rt);
			} catch (err) {
				console.error(`Hot reload: ${blockLabel(b.key)} failed`, err);
				const partial = _blockRuntimes.get(b.key);
				if (partial) teardownBlock(partial);
				if (!old) { errors.push({ b, err, rolledBack: false }); continue; }
				// Roll this block back to its last working code, state intact.
				try {
					const rt = await runTrackedBlock(old.code, b.key, { hot: true });
					restoreBlockState(snap, rt);
					setModelBlockCode(b, old.code);
					errors.push({ b, err, rolledBack: true });
				} catch (rollbackErr) {
					throw new Error(`${blockLabel(b.key)}: ${err.message}; rollback also failed (${rollbackErr.message})`);
				}
			}
		}
		updateCodeEditorHint();
		renderScenePanel();
		if (errors.length) {
			const e = errors[0];
			codeEditorDirty = true;
			setCodeEditorStatus(
				`Error in ${blockLabel(e.b.key)}: ${e.err?.message || e.err}` +
				(e.rolledBack ? ' (kept the previous version running)' : ''),
				'error'
			);
			return;
		}
		codeEditorLastApplied = buildCodeEditorSource();
		// Creation context: a hot-reloaded edit is a code edit like a full Apply.
		GSContext.recordCodeEdit({ code: codeEditorLastApplied, source: fromLive ? 'live' : 'apply' });
		codeEditorDirty = false;
		const n = changed.length;
		setCodeEditorStatus(
			`Hot reloaded ${n} block${n === 1 ? '' : 's'}` +
			(removed.length ? `, removed ${removed.length}` : '') +
			(restoredCount ? ' · state kept' : ''),
			'ok'
		);
	} catch (err) {
		// Last resort: the old clear-and-re-run of everything.
		console.error('Hot reload failed, doing a full reset:', err);
		codeEditorApplying = false;
		await applyCodeFromEditor({ fromLive });
		const cur = dchatCodeStatus ? dchatCodeStatus.textContent : '';
		setCodeEditorStatus(`Hot reload failed (${err.message}) · did a full reset. ${cur}`, dchatCodeStatus?.className || 'error');
		return;
	} finally {
		codeEditorApplying = false;
		if (dchatCodeApply) dchatCodeApply.disabled = false;
	}
}

function setModelBlockCode(b, code) {
	if (b.sceneId) {
		const sc = loadedScenes.find((x) => x.id === b.sceneId);
		const i = Number(b.key.split('#').pop());
		if (sc && sc.codeBlocks && i < sc.codeBlocks.length) sc.codeBlocks[i] = code;
	} else {
		const i = Number(b.key.slice(6));
		if (i < executedCodeBlocks.length) executedCodeBlocks[i] = code;
	}
}

function updateCodeEditorHint() {
	if (!dchatCodeHint) return;
	const sceneCount = loadedScenes.filter(s => s.active).reduce((n, s) => n + (s.codeBlocks?.length || 0), 0);
	const sessionCount = executedCodeBlocks.length;
	dchatCodeHint.textContent =
		`Active scenes: ${sceneCount} block${sceneCount === 1 ? '' : 's'} · Session: ${sessionCount} block${sessionCount === 1 ? '' : 's'}. ` +
		`Apply / Live hot reload only changed blocks and keep state; Full reset re-runs everything. ` +
		`Markers like // --- block N --- separate blocks.`;
}

function syncCodeEditorFromState({ force = false } = {}) {
	if (!dchatCodeEditor) return;
	if (codeEditorDirty && !force) return;
	const src = buildCodeEditorSource();
	dchatCodeEditor.value = src;
	codeHighlightApi?.refresh();
	codeEditorLastApplied = src;
	codeEditorDirty = false;
	updateCodeEditorHint();
	if (!codeEditorApplying) setCodeEditorStatus(src ? 'Synced' : 'Empty', '');
}

function notifyCodeEditorExternalChange() {
	// Refresh when chat/scenes change, unless the user is mid-edit.
	syncCodeEditorFromState({ force: false });
	updateCodeEditorHint();
}

function markCodeEditorDirty() {
	codeEditorDirty = true;
	setCodeEditorStatus('Edited', 'pending');
	if (dchatCodeLive && dchatCodeLive.checked) scheduleLiveCodeApply();
}

function scheduleLiveCodeApply() {
	if (codeEditorLiveTimer) clearTimeout(codeEditorLiveTimer);
	codeEditorLiveTimer = setTimeout(() => {
		codeEditorLiveTimer = null;
		hotReloadFromEditor({ fromLive: true });
	}, CODE_EDITOR_LIVE_DEBOUNCE_MS);
}

async function applyCodeFromEditor({ fromLive = false } = {}) {
	if (!dchatCodeEditor || codeEditorApplying) return;
	codeEditorApplying = true;
	setCodeEditorStatus(fromLive ? 'Live applying…' : 'Applying…', 'pending');
	if (dchatCodeApply) dchatCodeApply.disabled = true;
	try {
		const text = dchatCodeEditor.value;
		const { sceneUpdates, sessionBlocks } = parseCodeEditorSource(text);

		for (const [id, codes] of sceneUpdates) {
			const sc = loadedScenes.find(s => s.id === id);
			if (sc) sc.codeBlocks = codes;
		}
		executedCodeBlocks = sessionBlocks;

		clearUserObjects();
		for (const sc of loadedScenes) {
			if (!sc.active) continue;
			const codes = sc.codeBlocks || [];
			for (let i = 0; i < codes.length; i++) {
				await executeVrCode(codes[i], sceneBlockKey(sc, i));
			}
		}
		for (let i = 0; i < executedCodeBlocks.length; i++) {
			await executeVrCode(executedCodeBlocks[i], sessionBlockKey(i));
		}

		const normalized = buildCodeEditorSource();
		codeEditorLastApplied = normalized;
		GSContext.recordCodeEdit({ code: normalized, source: fromLive ? 'live' : 'apply' });
		// Keep caret-friendly: only rewrite textarea if markers/order changed meaningfully
		if (!codeEditorDirty || dchatCodeEditor.value.trim() === text.trim()) {
			dchatCodeEditor.value = normalized;
			codeHighlightApi?.refresh();
			codeEditorDirty = false;
		} else {
			codeEditorDirty = false;
		}
		updateCodeEditorHint();
		setCodeEditorStatus('Full reset: scene rebuilt from code', 'ok');
		renderScenePanel();
	} catch (err) {
		console.error('Code editor apply error:', err);
		setCodeEditorStatus(`Error: ${err?.message || err}`, 'error');
		// Don't crash the app; scene may be partially rebuilt — leave editor dirty
		codeEditorDirty = true;
	} finally {
		codeEditorApplying = false;
		if (dchatCodeApply) dchatCodeApply.disabled = false;
	}
}

function revertCodeEditor() {
	if (!dchatCodeEditor) return;
	if (codeEditorLiveTimer) {
		clearTimeout(codeEditorLiveTimer);
		codeEditorLiveTimer = null;
	}
	const src = codeEditorLastApplied || buildCodeEditorSource();
	dchatCodeEditor.value = src;
	codeHighlightApi?.refresh();
	codeEditorDirty = false;
	updateCodeEditorHint();
	setCodeEditorStatus('Reverted', '');
}

function clearUserObjects() {
	// Full reset: stop every block's timers/listeners/dispose hooks and forget
	// hot-reload state (scene objects are removed wholesale below).
	for (const rt of _blockRuntimes.values()) {
		for (const fn of rt.disposers) { try { fn(); } catch { /* ignore */ } }
		for (const id of rt.timeouts) window.clearTimeout(id);
		for (const id of rt.intervals) window.clearInterval(id);
		for (const id of rt.rafs) window.cancelAnimationFrame(id);
		for (const [target, type, fn, opts] of rt.listeners) { try { target.removeEventListener(type, fn, opts); } catch { /* ignore */ } }
	}
	_blockRuntimes.clear();
	_blockStates.clear();
	window.gsState = {};
	// Stop p5 sketches / drop canvas surfaces and scene-owned gamepad hooks
	// before the meshes and _vrAnimations they live in are thrown away.
	for (const surf of [...gsSurfaces]) {
		try { surf.dispose(); } catch (e) { console.error('surface dispose failed:', e); }
	}
	if (typeof gsGamepad !== 'undefined') gsGamepad._reset();
	for (let i = scene.children.length - 1; i >= 0; i--) {
		const child = scene.children[i];
		if (!systemObjectIds.has(child.uuid)) {
			scene.remove(child);
			disposeRecursive(child);
		}
	}
	// Walk-in-AR may have adopted user meshes under arPlacementRoot (a system
	// object), so also strip those — keep the placement marker itself.
	if (typeof arPlacementRoot !== 'undefined' && arPlacementRoot) {
		for (let i = arPlacementRoot.children.length - 1; i >= 0; i--) {
			const child = arPlacementRoot.children[i];
			if (child === arPlacementMarker) continue;
			if (systemObjectIds.has(child.uuid)) continue;
			arPlacementRoot.remove(child);
			disposeRecursive(child);
		}
	}
	window._vrAnimations = [];
	const overlay = document.getElementById('overlay-root');
	for (let i = overlay.children.length - 1; i >= 0; i--) {
		const child = overlay.children[i];
		if (child.id && !systemOverlayIds.has(child.id)) {
			overlay.removeChild(child);
		}
	}
}

/** Remove every user-placed object from the live 3D scene. Keeps imported
 *  scene files in the Scenes list (unchecked), Files library, and Community. */
function clearSceneContent() {
	const userRoots = scene.children.filter(c => !systemObjectIds.has(c.uuid)).length;
	const arExtras = (arPlacementRoot
		? arPlacementRoot.children.filter(c => c !== arPlacementMarker && !systemObjectIds.has(c.uuid)).length
		: 0);
	const activeCount = loadedScenes.filter(s => s.active).length;
	const sessionCount = executedCodeBlocks.length;
	if (userRoots + arExtras + activeCount + sessionCount === 0) {
		recenterOrbitPivot();
		updateStatus('Scene is already empty', '');
		return;
	}
	if (!window.confirm(
		'Clear all objects from the scene? Imported scene files stay in the list (unchecked). Files library and Community uploads are not affected.'
	)) return;

	for (const sc of loadedScenes) sc.active = false;
	executedCodeBlocks = [];
	clearUserObjects();
	recenterOrbitPivot();
	notifyCodeEditorExternalChange();
	renderScenePanel();
	updateStatus('Scene cleared', 'connected');
}

function rebuildSceneFromActive() {
	clearUserObjects();
	// Re-execute loaded scenes first. executeVrCode is async; we
	// fire-and-forget here and just log any rejections.
	for (const sc of loadedScenes) {
		if (sc.active) {
			sc.codeBlocks.forEach((code, i) => {
				Promise.resolve(executeVrCode(code, sceneBlockKey(sc, i))).catch(e => {
					console.error(`Scene "${sc.name}" error:`, e);
				});
			});
		}
	}
	// Then re-execute current session code
	executedCodeBlocks.forEach((code, i) => {
		Promise.resolve(executeVrCode(code, sessionBlockKey(i))).catch(e => {
			console.error('Session code error:', e);
		});
	});
}

function showExportModal(combined) {
	pendingExportCombined = combined;
	exportNameInput.value = combined ? 'Combined Scene' : 'My Scene';
	exportExtInput.value = sceneFileExtension;
	pendingExportThumbnail = null;
	exportPreview.innerHTML = '<span style="color:rgba(255,255,255,0.4);font-size:12px;text-align:center">No screenshot</span>';
	exportModal.style.display = 'flex';
}

function hideExportModal() {
	exportModal.style.display = 'none';
}

// Gathers the current exportable scene (active loaded scenes + this
// session's chat-executed code) into the on-disk/on-wire scene format.
// Shared by "Export" (save to server), "Save to Device" (local download),
// and "Upload Current Scene" (community).
function buildSceneData(name) {
	const codeBlocks = [];
	for (const sc of loadedScenes) {
		if (sc.active) codeBlocks.push(...sc.codeBlocks);
	}
	codeBlocks.push(...executedCodeBlocks);

	return {
		version: 1,
		name,
		createdAt: new Date().toISOString(),
		thumbnail: pendingExportThumbnail || '',
		codeBlocks,
		...GSMerge.sceneCredits(loadedScenes) // mergedFrom / credits of a merged scene
	};
}

async function doExport() {
	const name = exportNameInput.value.trim() || 'Untitled';
	const ext = exportExtInput.value.trim().replace(/^\./, '') || 'vrscene';
	sceneFileExtension = ext;

	// Saved scenes carry their creation context (chat + info log, scrubbed).
	const sceneData = await GSContext.withCreationContext(buildSceneData(name));

	fetch('/api/save-scene', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(sceneData)
	}).then(res => res.json()).then(data => {
		if (data.error) {
			updateStatus(`Export error: ${data.error}`, 'error');
		} else {
			updateStatus(`Exported "${name}" to server`, 'connected');
		}
	}).catch(err => {
		updateStatus(`Export error: ${err.message}`, 'error');
	});

	hideExportModal();
}

// Downloads the current scene as a local file (a real save-to-disk, unlike
// "Export" above which only saves to this server's single scene slot).
async function doDownloadExport() {
	const name = exportNameInput.value.trim() || 'Untitled';
	const ext = exportExtInput.value.trim().replace(/^\./, '') || 'vrscene';
	sceneFileExtension = ext;

	const sceneData = await GSContext.withCreationContext(buildSceneData(name));
	const blob = new Blob([JSON.stringify(sceneData, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);

	updateStatus(`Saved "${name}" to your device`, 'connected');
	hideExportModal();
}

// Adds a loaded scene's code blocks to the scene, runs them, and refreshes
// the scene list/thumbnails. Shared by file import, folder import, the
// single server-saved scene, and community scenes.
function addLoadedScene(data, fallbackName) {
	if (!data || !data.codeBlocks || !Array.isArray(data.codeBlocks)) {
		throw new Error('Invalid scene data: missing codeBlocks');
	}
	const sc = {
		id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
		name: data.name || fallbackName,
		thumbnail: data.thumbnail || '',
		codeBlocks: data.codeBlocks,
		active: true,
		createdAt: data.createdAt || new Date().toISOString(),
		_thumbImage: null,
		...(Array.isArray(data.mergedFrom) ? { mergedFrom: data.mergedFrom } : {})
	};
	loadedScenes.push(sc);
	recenterOrbitPivot();

	// Execute the scene's code blocks (async; surface failures via console)
	sc.codeBlocks.forEach((code, i) => {
		Promise.resolve(executeVrCode(code, sceneBlockKey(sc, i))).catch(err => {
			console.error(`Scene "${sc.name}" load error:`, err);
		});
	});

	loadSceneThumbnails();
	renderScenePanel();
	notifyCodeEditorExternalChange();
	GSContext.restoreFromScene(data, { source: 'file' }).catch(err => console.warn('creation context restore failed:', err));
	return sc;
}

function loadSceneFile(file) {
	const reader = new FileReader();
	reader.onload = (e) => {
		try {
			const data = JSON.parse(e.target.result);
			const sc = addLoadedScene(data, file.name.replace(/\.[^.]+$/, ''));
			updateStatus(`Loaded "${sc.name}"`, 'connected');
		} catch (err) {
			console.error('Error parsing scene file:', err);
			updateStatus(`Load error: ${err.message}`, 'error');
		}
	};
	reader.readAsText(file);
}

fileInput.addEventListener('change', (e) => {
	for (const file of e.target.files) loadSceneFile(file);
	fileInput.value = '';
});

// Whole-folder import: webkitdirectory hands back every file in the tree,
// so only pick up the scene files and ignore anything else that's in there.
folderInput.addEventListener('change', (e) => {
	const files = [...e.target.files].filter(f => /\.(vrscene|json)$/i.test(f.name));
	if (files.length === 0) {
		updateStatus('No .vrscene/.json files found in that folder', 'error');
	} else {
		for (const file of files) loadSceneFile(file);
	}
	folderInput.value = '';
});

function loadSceneFromServer() {
	updateStatus('Loading scene...', 'connecting');
	fetch('/api/load-scene')
		.then(res => {
			if (!res.ok) throw new Error(res.status === 404 ? 'No saved scene found' : 'Server error');
			return res.json();
		})
		.then(data => {
			const sc = addLoadedScene(data, 'Loaded Scene');
			updateStatus(`Loaded "${sc.name}"`, 'connected');
		})
		.catch(err => {
			updateStatus(`Load error: ${err.message}`, 'error');
		});
}

// --- Community scenes (shared, persistent, server-side via /api/community-scenes) ---
// Shareable URLs: /s/:id (display-only) and /e/:id (editor), plus ?scene=&view=1 / ?display=1.

const shareModal = document.getElementById('share-modal');
const shareModalTitle = document.getElementById('share-modal-title');
const shareDisplayOnly = document.getElementById('share-display-only');
const shareUrlInput = document.getElementById('share-url');
const shareCloseBtn = document.getElementById('share-close-btn');
const shareCopyBtn = document.getElementById('share-copy-btn');
const renameModal = document.getElementById('rename-modal');
const renameNameInput = document.getElementById('rename-name');
const renameCancelBtn = document.getElementById('rename-cancel-btn');
const renameConfirmBtn = document.getElementById('rename-confirm-btn');
const editorLink = document.getElementById('editor-link');

function parseShareRoute() {
	const path = window.location.pathname.replace(/\/+$/, '') || '/';
	const params = new URLSearchParams(window.location.search);
	const pathMatch = path.match(/^\/(s|e)\/([A-Za-z0-9_-]+)$/);
	if (pathMatch) {
		return { sceneId: pathMatch[2], displayOnly: pathMatch[1] === 's' };
	}
	return {
		sceneId: params.get('scene'),
		displayOnly: params.get('view') === '1' || params.get('display') === '1'
	};
}

function applyDisplayOnlyMode() {
	displayOnlyMode = true;
	document.body.classList.add('display-only');
	setUiCollapsed(true);
	if (uiTogglePanel) uiTogglePanel.visible = false;
	if (hudStatusPanel) hudStatusPanel.visible = false;
	if (typeof setDesktopChatMinimized === 'function') {
		setDesktopChatMinimized(true);
	} else if (desktopChat) {
		desktopChat.classList.add('hidden');
	}
	// XRButton injects a bottom-centered <button> without a stable id.
	for (const btn of document.querySelectorAll('#app button, body > button, #gs-dock button')) {
		const t = (btn.textContent || '').toLowerCase();
		if (t.includes('enter') && (t.includes('ar') || t.includes('vr') || t.includes('xr'))) {
			btn.style.display = 'none';
		}
	}
}

function currentShareUrl() {
	if (!pendingShare) return '';
	return shareDisplayOnly && shareDisplayOnly.checked ? pendingShare.viewUrl : pendingShare.editorUrl;
}

function sharePayloadFromMeta(meta, urls = {}) {
	const origin = window.location.origin;
	const id = meta.id || urls.id;
	return {
		id,
		name: meta.name || 'Untitled',
		editorUrl: urls.editorUrl || meta.editorUrl || (id ? `${origin}/e/${id}` : ''),
		viewUrl: urls.viewUrl || meta.viewUrl || (id ? `${origin}/s/${id}` : '')
	};
}

function showShareModal(share) {
	if (displayOnlyMode) return;
	pendingShare = share;
	if (shareModalTitle) shareModalTitle.textContent = share.name ? `Share "${share.name}"` : 'Share Scene';
	if (shareDisplayOnly) shareDisplayOnly.checked = false;
	if (shareUrlInput) shareUrlInput.value = currentShareUrl();
	if (shareCopyBtn) shareCopyBtn.textContent = 'Copy link';
	if (shareModal) shareModal.classList.add('visible');
	if (shareUrlInput) {
		shareUrlInput.focus();
		shareUrlInput.select();
	}
}

function hideShareModal() {
	if (shareModal) shareModal.classList.remove('visible');
}

function showRenameModal(cs, kind = 'scene') {
	if (displayOnlyMode || !cs) return;
	pendingRename = cs;
	pendingRenameKind = kind === 'theme' ? 'theme' : 'scene';
	if (renameNameInput) renameNameInput.value = cs.name || '';
	if (renameModal) renameModal.classList.add('visible');
	setTimeout(() => {
		if (!renameNameInput) return;
		renameNameInput.focus();
		renameNameInput.select();
	}, 0);
}

function hideRenameModal() {
	if (renameModal) renameModal.classList.remove('visible');
	pendingRename = null;
	pendingRenameKind = 'scene';
}

async function copyText(text) {
	if (!text) return false;
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through
	}
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.position = 'fixed';
	ta.style.left = '-9999px';
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try { ok = document.execCommand('copy'); } catch { ok = false; }
	document.body.removeChild(ta);
	return ok;
}

async function uploadCurrentSceneToCommunity() {
	if (displayOnlyMode) return null;
	const name = (loadedScenes.find(s => s.active)?.name) || 'My Scene';
	let sceneData = buildSceneData(name);
	if (sceneData.codeBlocks.length === 0) {
		updateStatus('Nothing to upload - add or load something first', 'error');
		return null;
	}
	// Ask whether to publish the creation context (chat + files); null = cancelled.
	sceneData = await GSContext.preparePublish(sceneData);
	if (!sceneData) {
		updateStatus('Upload cancelled', '');
		return null;
	}
	updateStatus('Uploading to community...', 'connecting');
	return fetch('/api/community-scenes', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(sceneData)
	}).then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ ok, data }) => {
		if (!ok || data.error) throw new Error(data.error || 'Upload failed');
		updateStatus(`Uploaded "${data.scene?.name || name}" to community`, 'connected');
		refreshCommunityScenes();
		const share = sharePayloadFromMeta(data.scene || { name, id: data.id }, data);
		lastUploadedShare = { sig: JSON.stringify(sceneData.codeBlocks), share };
		showShareModal(share);
		return share;
	}).catch(err => {
		updateStatus(`Upload error: ${err.message}`, 'error');
		return null;
	});
}

// Share tab / VR "Share link": the Community share link for the current
// scene. An unchanged loaded Community scene (or one just uploaded) reuses its
// id; anything else goes through uploadCurrentSceneToCommunity, the same flow
// as Community → Upload Current Scene. Desktop gets the same share modal; in
// VR (modal not visible) the editor link is copied instead.
let lastUploadedShare = null;
function shareCurrentScene() {
	if (displayOnlyMode) return Promise.resolve(null);
	const active = loadedScenes.filter(s => s.active);
	const sig = JSON.stringify(buildSceneData('').codeBlocks);
	let share = null;
	if (active.length === 1 && active[0].communityId && executedCodeBlocks.length === 0
		&& JSON.stringify(active[0].codeBlocks) === active[0].communitySig) {
		share = sharePayloadFromMeta({ id: active[0].communityId, name: active[0].name }, active[0]);
	} else if (lastUploadedShare && lastUploadedShare.sig === sig) {
		share = lastUploadedShare.share;
	}
	const copyInXr = (s) => {
		if (s && renderer.xr.isPresenting) {
			copyText(s.editorUrl).then(ok => updateStatus(ok ? `Share link copied: ${s.editorUrl}` : `Share link: ${s.editorUrl}`, 'connected'));
		}
		return s;
	};
	if (!share) return uploadCurrentSceneToCommunity().then(copyInXr); // shows the share modal itself
	if (!renderer.xr.isPresenting) showShareModal(share);
	return Promise.resolve(copyInXr(share));
}

function refreshCommunityScenes() {
	if (!dchatCommunityList) return;
	dchatCommunityList.innerHTML = '<div class="dchat-scene-empty">Loading...</div>';
	fetch('/api/community-scenes')
		.then(res => res.json().then(data => ({ ok: res.ok, data })))
		.then(({ ok, data }) => {
			if (!ok || data.error) throw new Error(data.error || 'Failed to list community scenes');
			renderCommunitySceneList(data.scenes || []);
		})
		.catch(err => {
			dchatCommunityList.innerHTML = '';
			const empty = document.createElement('div');
			empty.className = 'dchat-scene-empty';
			empty.textContent = err.message;
			dchatCommunityList.appendChild(empty);
		});
}


/** Short local datetime for Community list meta (browser locale / TZ). */
function formatCommunityDate(iso) {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

/** Compact form for XR panel rows. */
function formatCommunityDateShort(iso) {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

/** Resolve created/updated from list payload (createdAt/updatedAt or uploadedAt fallback). */
function communityTimestamps(item) {
	if (!item) return { createdAt: null, updatedAt: null };
	const updatedAt = item.updatedAt || item.uploadedAt || null;
	const createdAt = item.createdAt || updatedAt || null;
	return { createdAt, updatedAt };
}

function communityDatesMetaText(item, { short = false } = {}) {
	const { createdAt, updatedAt } = communityTimestamps(item);
	const fmt = short ? formatCommunityDateShort : formatCommunityDate;
	const created = fmt(createdAt);
	const modified = fmt(updatedAt);
	if (!created && !modified) return '';
	if (created && modified && created === modified) {
		return short ? created : `Created ${created}`;
	}
	const parts = [];
	if (created) parts.push(short ? `C ${created}` : `Created ${created}`);
	if (modified) parts.push(short ? `M ${modified}` : `Modified ${modified}`);
	return parts.join(' · ');
}

function appendCommunityDatesEl(parent, item) {
	const text = communityDatesMetaText(item);
	if (!text) return null;
	const dates = document.createElement('div');
	dates.className = 'dchat-scene-dates';
	dates.textContent = text;
	dates.title = text;
	parent.appendChild(dates);
	return dates;
}

function renderCommunitySceneList(scenes) {
	communityScenesCache = scenes;
	if (scenePanelSubTab === 'community') renderScenePanel();

	dchatCommunityList.innerHTML = '';
	if (scenes.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.textContent = 'No community scenes yet. Be the first to upload one!';
		dchatCommunityList.appendChild(empty);
		return;
	}
	for (const cs of scenes) {
		const item = document.createElement('div');
		item.className = 'dchat-scene-item dchat-community-scene';

		const nameRow = document.createElement('div');
		nameRow.className = 'dchat-scene-info dchat-community-scene-name-row';

		const name = document.createElement('div');
		name.className = 'dchat-scene-name';
		name.textContent = cs.name;
		name.title = cs.name + (cs.id ? ` (${cs.id})` : '');
		nameRow.appendChild(name);
		appendCommunityDatesEl(nameRow, cs);

		const actions = document.createElement('div');
		actions.className = 'dchat-scene-actions dchat-community-scene-actions-row';

		const loadKey = communitySceneKeyFrom(cs);
		if (loadKey && loadedScenes.some(s => s.communityKey === loadKey && s.active)) {
			item.classList.add('active');
		}

		const load = document.createElement('button');
		load.className = 'dchat-btn';
		load.textContent = 'Load';
		load.addEventListener('click', () => { loadCommunityScene(cs).catch(() => {}); });

		const share = document.createElement('button');
		share.className = 'dchat-btn';
		share.textContent = 'Share';
		share.addEventListener('click', () => {
			showShareModal(sharePayloadFromMeta(cs));
		});

		const rename = document.createElement('button');
		rename.className = 'dchat-btn';
		rename.textContent = 'Rename';
		rename.addEventListener('click', () => showRenameModal(cs));

		actions.append(load, share, rename);
		GSMerge.decorateCommunityRow(actions, cs); // "Merge" pick button
		item.append(nameRow, actions);
		dchatCommunityList.appendChild(item);
	}
}

// Identity for "this community scene is already in the world": server id,
// else the blob url for legacy records that have no id. One loadedScenes
// entry per key; code runs only when that entry is not already active
// (layer) or after the world is blanked (clear / replace).
function communitySceneKeyFrom(cs) {
	if (!cs) return null;
	const id = cs.id || cs.communityId;
	if (id) return `id:${id}`;
	if (cs.url) return `url:${cs.url}`;
	return null;
}

function findLoadedByCommunityKey(key) {
	if (!key) return null;
	return loadedScenes.find(s => s.communityKey === key) || null;
}

function communityLoadModeButtons() {
	return [
		{
			id: 'loadClear',
			label: 'Clear first',
			action: 'community:loadMode:clear',
			variant: communityLoadMode === 'clear' ? 'active' : 'inactiveToggle'
		},
		{
			id: 'loadLayer',
			label: 'Layer',
			action: 'community:loadMode:layer',
			variant: communityLoadMode === 'layer' ? 'active' : 'inactiveToggle'
		}
	];
}

/** Desktop Community header controls as HTML buttons (not SVG).
 *  SVG mounts use width:100% + meet and grow with panel width/DPI, which
 *  can crush #dchat-community-list to ~0 height on wide desktops. XR still
 *  draws COMMUNITY_BUTTONS via the canvas menuSystem path. */
function mountHtmlActionButtons(container, specs, { accentVariants = ['accent', 'active'] } = {}) {
	if (!container) return;
	container.innerHTML = '';
	for (const spec of specs) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'dchat-btn';
		const v = spec.variant || '';
		if (accentVariants.includes(v)) btn.classList.add('accent');
		else if (v === 'secondary' || v === 'inactiveToggle') btn.classList.add('secondary');
		btn.textContent = spec.label;
		btn.dataset.action = spec.action;
		btn.addEventListener('click', () => handleMenuAction(spec.action));
		container.appendChild(btn);
	}
}

function renderCommunityDesktopButtons() {
	mountHtmlActionButtons(dchatCommunityButtonsMount, COMMUNITY_BUTTONS);
}

function renderCommunityLoadModeControls() {
	mountHtmlActionButtons(dchatCommunityLoadModeMount, communityLoadModeButtons());
}

function setCommunityLoadMode(mode) {
	communityLoadMode = mode === 'layer' ? 'layer' : 'clear';
	renderCommunityLoadModeControls();
	if (scenePanelSubTab === 'community') renderScenePanel();
	updateStatus(
		communityLoadMode === 'layer'
			? 'Community load: layer onto the current scene'
			: 'Community load: clear the scene first',
		''
	);
}

// Clear-load bumps both tokens so older clear-loads and older layer-loads
// do not apply. Layer-load bumps only the clear epoch (a later layer must
// not be wiped by an in-flight clear) and does not cancel other layers.
function beginCommunityLoad(loadMode) {
	if (loadMode === 'clear') {
		communityClearEpoch += 1;
		communityLayerCancel += 1;
		return { mode: 'clear', epoch: communityClearEpoch, layerCancel: communityLayerCancel };
	}
	communityClearEpoch += 1;
	return { mode: 'layer', epoch: communityClearEpoch, layerCancel: communityLayerCancel };
}

function communityLoadStillCurrent(ticket) {
	if (ticket.mode === 'clear') return ticket.epoch === communityClearEpoch;
	return ticket.layerCancel === communityLayerCancel;
}

/** Blank the live world the same way Clear scene does, without the confirm
 *  and without dropping imported files from the Scenes list. */
function blankLiveSceneForCommunityLoad() {
	for (const sc of loadedScenes) sc.active = false;
	executedCodeBlocks = [];
	clearUserObjects();
}

function runLoadedSceneCode(sc) {
	recenterOrbitPivot();
	const blocks = sc.codeBlocks || [];
	return Promise.all(blocks.map((code, i) =>
		Promise.resolve(executeVrCode(code, sceneBlockKey(sc, i))).catch(err => {
			console.error(`Scene "${sc.name}" load error:`, err);
		})
	));
}

function enqueueCommunityApply(fn) {
	const apply = communityApplyChain.then(fn, fn);
	communityApplyChain = apply.then(() => {}, () => {});
	return apply;
}

function upsertCommunityLoadedScene(data, fallbackName, key) {
	let sc = findLoadedByCommunityKey(key);
	if (!sc) {
		sc = {
			id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
			name: data.name || fallbackName,
			thumbnail: data.thumbnail || '',
			codeBlocks: data.codeBlocks,
			active: true,
			createdAt: data.createdAt || new Date().toISOString(),
			_thumbImage: null,
			communityKey: key,
			communityId: data.id || (key.startsWith('id:') ? key.slice(3) : null)
		};
		loadedScenes.push(sc);
	} else {
		sc.name = data.name || sc.name || fallbackName;
		if (data.thumbnail) sc.thumbnail = data.thumbnail;
		sc.codeBlocks = Array.isArray(data.codeBlocks) ? data.codeBlocks : sc.codeBlocks;
		sc.active = true;
		sc.communityKey = key;
		if (data.id) sc.communityId = data.id;
	}
	sc.communitySig = JSON.stringify(sc.codeBlocks); // shareCurrentScene: unchanged since load?
	if (data.editorUrl) sc.editorUrl = data.editorUrl;
	if (data.viewUrl) sc.viewUrl = data.viewUrl;
	if (Array.isArray(data.mergedFrom)) sc.mergedFrom = data.mergedFrom;
	return sc;
}

function finishCommunityLoadUi() {
	loadSceneThumbnails();
	notifyCodeEditorExternalChange();
	if (dchatCommunityList && communityScenesCache.length) renderCommunitySceneList(communityScenesCache);
	else renderScenePanel();
}

function loadCommunityScene(cs, { mode = communityLoadMode } = {}) {
	const name = (cs && cs.name) || 'Community scene';
	const key = communitySceneKeyFrom(cs);
	if (!key) {
		const err = new Error('Community scene has no id');
		updateStatus(`Load error: ${err.message}`, 'error');
		return Promise.reject(err);
	}
	const loadMode = mode === 'layer' ? 'layer' : 'clear';

	// Layer + already active: no-op. Never execute the code again.
	if (loadMode === 'layer') {
		const existing = findLoadedByCommunityKey(key);
		if (existing && existing.active) {
			updateStatus(`"${existing.name}" is already loaded`, '');
			return Promise.resolve(existing);
		}
	}

	const inflightKey = `${loadMode}:${key}`;
	const inflight = communityLoadInflight.get(inflightKey);
	// Reuse only a still-current fetch. A superseded one resolves to null and
	// must not swallow a newer click on the same scene.
	if (inflight && communityLoadStillCurrent(inflight.ticket)) {
		updateStatus(`Loading "${name}"...`, 'connecting');
		return inflight.promise;
	}

	const ticket = beginCommunityLoad(loadMode);
	updateStatus(`Loading "${name}"...`, 'connecting');
	const fetchUrl = cs.id ? `/api/community-scenes/${encodeURIComponent(cs.id)}` : cs.url;

	const promise = fetch(fetchUrl)
		.then(res => {
			if (!res.ok) throw new Error('Failed to fetch community scene');
			return res.json();
		})
		.then(data => enqueueCommunityApply(async () => {
			if (!data || !Array.isArray(data.codeBlocks)) {
				throw new Error('Invalid scene data: missing codeBlocks');
			}
			if (!communityLoadStillCurrent(ticket)) return null;
			// Prefer the id we asked for so list rows and the fetched record match.
			const resolvedKey = communitySceneKeyFrom({ id: cs.id || data.id, url: cs.url || data.url }) || key;
			if (loadMode === 'clear') {
				// Replace in place: one entry, world blanked, code run once.
				blankLiveSceneForCommunityLoad();
				const sc = upsertCommunityLoadedScene(data, data.name || name, resolvedKey);
				await runLoadedSceneCode(sc);
				finishCommunityLoadUi();
				updateStatus(`Loaded "${sc.name}"`, 'connected');
				GSContext.restoreFromScene(data, { key: resolvedKey, source: 'community' }).catch(err => console.warn('creation context restore failed:', err));
				return sc;
			}
			const existing = findLoadedByCommunityKey(resolvedKey);
			if (existing && existing.active) {
				updateStatus(`"${existing.name}" is already loaded`, '');
				return existing;
			}
			const sc = upsertCommunityLoadedScene(data, data.name || name, resolvedKey);
			await runLoadedSceneCode(sc);
			finishCommunityLoadUi();
			updateStatus(`Layered "${sc.name}"`, 'connected');
			GSContext.restoreFromScene(data, { key: resolvedKey, source: 'community' }).catch(err => console.warn('creation context restore failed:', err));
			return sc;
		}))
		.catch(err => {
			updateStatus(`Load error: ${err.message}`, 'error');
			throw err;
		})
		.finally(() => {
			const cur = communityLoadInflight.get(inflightKey);
			if (cur && cur.promise === promise) communityLoadInflight.delete(inflightKey);
		});

	communityLoadInflight.set(inflightKey, { promise, ticket });
	return promise;
}

async function loadCommunitySceneById(sceneId, { activate = true } = {}) {
	if (!activate) {
		const res = await fetch(`/api/community-scenes/${encodeURIComponent(sceneId)}`);
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || 'Scene not found');
		return data;
	}
	const sc = await loadCommunityScene({ id: sceneId, name: 'Shared Scene' });
	if (!sc) throw new Error('Scene not found');
	return sc;
}

async function renameCommunityScene() {
	const cs = pendingRename;
	const kind = pendingRenameKind;
	const name = renameNameInput ? renameNameInput.value.trim() : '';
	if (!cs || !cs.id) {
		hideRenameModal();
		return;
	}
	if (!name) {
		updateStatus('Name cannot be empty', 'error');
		return;
	}
	hideRenameModal();
	try {
		if (kind === 'theme') {
			const res = await fetch(`/api/community-themes/${encodeURIComponent(cs.id)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
			updateStatus(`Renamed theme to "${data.theme?.name || name}"`, 'connected');
			refreshCommunityThemes();
			return;
		}
		const res = await fetch(`/api/community-scenes/${encodeURIComponent(cs.id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
		updateStatus(`Renamed to "${data.scene?.name || name}"`, 'connected');
		refreshCommunityScenes();
	} catch (err) {
		updateStatus(`Rename error: ${err.message}`, 'error');
	}
}


// --- Community themes (editor chrome) + theme restyle chat ---

const DEFAULT_THEME = {
	name: 'Default',
	cssVars: {
		'--dchat-bg': 'rgba(22, 22, 32, 0.85)',
		'--dchat-border': '#ffffff',
		'--dchat-text': '#ffffff',
		'--dchat-text-muted': 'rgba(255, 255, 255, 0.55)',
		'--dchat-header-bg': 'rgba(22, 22, 32, 0.85)',
		'--dchat-tabs-bg': 'rgba(22, 22, 32, 0.85)',
		'--dchat-tab-color': 'rgba(255, 255, 255, 0.5)',
		'--dchat-tab-active-bg': '#4f46e5',
		'--dchat-tab-active-color': '#ffffff',
		'--dchat-input-bg': 'rgba(255, 255, 255, 0.1)',
		'--dchat-accent': '#8b5cf6',
		'--dchat-accent-2': '#6366f1',
		'--dchat-radius': '18px',
		'--dchat-font': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
	},
	customCSS: ''
};

function getThemeStyleEl() {
	let el = document.getElementById('dchat-theme-style');
	if (!el) {
		el = document.createElement('style');
		el.id = 'dchat-theme-style';
		document.head.appendChild(el);
	}
	return el;
}

function applyTheme(theme, { announce = false } = {}) {
	if (!desktopChat || !theme || !theme.cssVars) return;
	const vars = theme.cssVars;
	// Clear previous custom vars by resetting known keys to defaults first
	for (const k of Object.keys(DEFAULT_THEME.cssVars)) {
		desktopChat.style.removeProperty(k);
	}
	for (const [k, v] of Object.entries(vars)) {
		if (typeof k === 'string' && k.startsWith('--') && typeof v === 'string') {
			desktopChat.style.setProperty(k, v);
		}
	}
	const styleEl = getThemeStyleEl();
	const custom = typeof theme.customCSS === 'string' ? theme.customCSS : '';
	// Soft-scope: only keep rules that mention #desktop-chat, or wrap bare rules.
	styleEl.textContent = custom ? custom : '';
	currentTheme = {
		name: theme.name || 'Custom',
		cssVars: { ...vars },
		customCSS: custom
	};
	cacheLastTheme(currentTheme);
	if (announce) updateStatus(`Theme: ${currentTheme.name}`, 'connected');
}

const THEME_CACHE_KEY = 'carljr-theme';
// This preference always persists. Absent or anything other than '1' means off.
const THEME_REMEMBER_KEY = 'carljr-theme-remember';

function loadRememberTheme() {
	try {
		return localStorage.getItem(THEME_REMEMBER_KEY) === '1';
	} catch { /* ignore */ }
	return false;
}

let rememberTheme = loadRememberTheme();

function syncRememberThemeCheckboxes() {
	if (dchatThemeRemember) dchatThemeRemember.checked = rememberTheme;
	if (dchatThemeRememberCommunity) dchatThemeRememberCommunity.checked = rememberTheme;
}

function setRememberTheme(on) {
	rememberTheme = !!on;
	try {
		localStorage.setItem(THEME_REMEMBER_KEY, rememberTheme ? '1' : '0');
	} catch { /* ignore quota */ }
	syncRememberThemeCheckboxes();
	cacheLastTheme(currentTheme || DEFAULT_THEME);
	if (chatCanvas) renderChatToCanvas();
	if (scenePanelSubTab === 'community' && communitySection === 'themes') renderScenePanel();
}

function cacheLastTheme(theme) {
	try {
		// Remember-theme is opt-in. While it is off, drop any previously saved theme
		// so a later visit cannot restore it and live edits are not written.
		if (!rememberTheme) {
			localStorage.removeItem(THEME_CACHE_KEY);
			return;
		}
		if (!theme || !theme.cssVars) return;
		localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({
			name: theme.name || 'Custom',
			cssVars: { ...theme.cssVars },
			customCSS: typeof theme.customCSS === 'string' ? theme.customCSS : ''
		}));
	} catch { /* ignore quota */ }
}

function loadCachedTheme() {
	try {
		const raw = localStorage.getItem(THEME_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed && parsed.cssVars && typeof parsed.cssVars === 'object') return parsed;
	} catch { /* ignore */ }
	return null;
}

function snapshotCurrentTheme(name) {
	const cssVars = {};
	const cs = desktopChat ? getComputedStyle(desktopChat) : null;
	for (const k of Object.keys(DEFAULT_THEME.cssVars)) {
		let v = desktopChat?.style?.getPropertyValue(k)?.trim();
		if (!v && cs) v = cs.getPropertyValue(k)?.trim();
		if (!v) v = DEFAULT_THEME.cssVars[k];
		cssVars[k] = v;
	}
	// Also pick up any extra --dchat-* set inline
	if (desktopChat?.style) {
		for (let i = 0; i < desktopChat.style.length; i++) {
			const prop = desktopChat.style.item(i);
			if (prop.startsWith('--') && !(prop in cssVars)) {
				cssVars[prop] = desktopChat.style.getPropertyValue(prop).trim();
			}
		}
	}
	const styleEl = document.getElementById('dchat-theme-style');
	return {
		name: name || currentTheme?.name || 'My Theme',
		cssVars,
		customCSS: styleEl?.textContent || currentTheme?.customCSS || ''
	};
}

function parseThemeJsonBlocks(text) {
	const themes = [];
	const displayText = String(text || '').replace(/```theme-json\n([\s\S]*?)```/g, (match, body) => {
		try {
			const obj = JSON.parse(body.trim());
			if (obj && obj.cssVars && typeof obj.cssVars === 'object') {
				themes.push({
					name: obj.name || 'AI Theme',
					cssVars: obj.cssVars,
					customCSS: typeof obj.customCSS === 'string' ? obj.customCSS : ''
				});
				return `[Applied theme "${obj.name || 'AI Theme'}"]`;
			}
		} catch { /* ignore bad JSON */ }
		return '[Invalid theme-json block]';
	});
	// Also accept ```theme-css fences as customCSS-only overlays
	const withCss = displayText.replace(/```theme-css\n([\s\S]*?)```/g, (match, body) => {
		themes.push({
			name: currentTheme?.name || 'Custom CSS',
			cssVars: { ...(currentTheme?.cssVars || DEFAULT_THEME.cssVars) },
			customCSS: body.trim()
		});
		return '[Applied theme CSS]';
	});
	return { displayText: withCss.trim(), themes };
}

function setCommunitySection(section) {
	communitySection = section === 'themes' ? 'themes' : 'scenes';
	document.querySelectorAll('#dchat-community-subtabs .dchat-subtab').forEach(btn => {
		btn.classList.toggle('active', btn.dataset.communitySection === communitySection);
	});
	const scenesSec = document.getElementById('dchat-community-section-scenes');
	const themesSec = document.getElementById('dchat-community-section-themes');
	if (scenesSec) scenesSec.classList.toggle('active', communitySection === 'scenes');
	if (themesSec) themesSec.classList.toggle('active', communitySection === 'themes');
	if (communitySection === 'themes') refreshCommunityThemes();
	else refreshCommunityScenes();
}

function setChatSection(section) {
	chatSection = section === 'theme' || section === 'prompt' ? section : 'scene';
	document.querySelectorAll('#dchat-chat-subtabs .dchat-subtab').forEach(btn => {
		btn.classList.toggle('active', btn.dataset.chatSection === chatSection);
	});
	const sceneSec = document.getElementById('dchat-chat-section-scene');
	const themeSec = document.getElementById('dchat-chat-section-theme');
	if (sceneSec) sceneSec.classList.toggle('active', chatSection === 'scene');
	if (themeSec) themeSec.classList.toggle('active', chatSection === 'theme');
	const promptSec = document.getElementById('dchat-chat-section-prompt');
	if (promptSec) promptSec.classList.toggle('active', chatSection === 'prompt');
	// The prompt reads top-down; chats start at the newest message.
	chatScrollOffset = chatSection === 'prompt' ? 1e6 : 0;
	renderChatToCanvas();
	renderInputToCanvas();
}

function uploadCurrentThemeToCommunity() {
	if (displayOnlyMode) return;
	const name = window.prompt('Theme name?', currentTheme?.name || 'My Theme');
	if (name == null) return;
	const theme = snapshotCurrentTheme(name.trim() || 'My Theme');
	updateStatus('Uploading theme...', 'connecting');
	fetch('/api/community-themes', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(theme)
	}).then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ ok, data }) => {
		if (!ok || data.error) throw new Error(data.error || 'Upload failed');
		currentTheme = theme;
		cacheLastTheme(theme);
		updateStatus(`Uploaded theme "${data.theme?.name || theme.name}"`, 'connected');
		refreshCommunityThemes();
	}).catch(err => {
		updateStatus(`Theme upload error: ${err.message}`, 'error');
	});
}

function refreshCommunityThemes() {
	const xrThemes = scenePanelSubTab === 'community' && communitySection === 'themes';
	if (!dchatThemesList && !xrThemes) return;
	if (dchatThemesList) dchatThemesList.innerHTML = '<div class="dchat-scene-empty">Loading...</div>';
	fetch('/api/community-themes')
		.then(res => res.json().then(data => ({ ok: res.ok, data })))
		.then(({ ok, data }) => {
			if (!ok || data.error) throw new Error(data.error || 'Failed to list themes');
			renderCommunityThemeList(data.themes || []);
		})
		.catch(err => {
			communityThemesCache = [];
			if (xrThemes) renderScenePanel();
			if (!dchatThemesList) return;
			dchatThemesList.innerHTML = '';
			const empty = document.createElement('div');
			empty.className = 'dchat-scene-empty';
			empty.textContent = err.message;
			dchatThemesList.appendChild(empty);
		});
}

function renderCommunityThemeList(themes) {
	communityThemesCache = themes;
	if (scenePanelSubTab === 'community' && communitySection === 'themes') renderScenePanel();
	if (!dchatThemesList) return;
	dchatThemesList.innerHTML = '';
	if (themes.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.textContent = 'No community themes yet. Restyle via chat, then upload!';
		dchatThemesList.appendChild(empty);
		return;
	}
	for (const th of themes) {
		const item = document.createElement('div');
		item.className = 'dchat-scene-item';

		const info = document.createElement('div');
		info.className = 'dchat-scene-info';

		const name = document.createElement('div');
		name.className = 'dchat-scene-name';
		name.textContent = th.name;
		name.title = th.name + (th.id ? ` (${th.id})` : '');
		info.appendChild(name);
		appendCommunityDatesEl(info, th);

		const actions = document.createElement('div');
		actions.className = 'dchat-scene-actions';

		const apply = document.createElement('button');
		apply.className = 'dchat-btn accent';
		apply.textContent = 'Apply';
		apply.addEventListener('click', () => applyCommunityTheme(th));

		const rename = document.createElement('button');
		rename.className = 'dchat-btn';
		rename.textContent = 'Rename';
		rename.addEventListener('click', () => showRenameModal(th, 'theme'));

		actions.append(apply, rename);
		item.append(info, actions);
		dchatThemesList.appendChild(item);
	}
}

function applyCommunityTheme(th) {
	updateStatus(`Loading theme "${th.name}"...`, 'connecting');
	const fetchUrl = th.id ? `/api/community-themes/${encodeURIComponent(th.id)}` : th.url;
	fetch(fetchUrl)
		.then(res => {
			if (!res.ok) throw new Error('Failed to fetch theme');
			return res.json();
		})
		.then(data => {
			applyTheme(data, { announce: true });
		})
		.catch(err => {
			updateStatus(`Theme load error: ${err.message}`, 'error');
		});
}

function appendThemeChatBubble(role, content) {
	if (!dchatThemeChatMessages) return;
	const div = document.createElement('div');
	div.className = `dchat-theme-msg ${role}`;
	div.textContent = content;
	dchatThemeChatMessages.appendChild(div);
	dchatThemeChatMessages.scrollTop = dchatThemeChatMessages.scrollHeight;
}

async function sendThemeChat() {
	if (themeChatLoading || displayOnlyMode) return;
	const text = (dchatThemeChatInput?.value || '').trim();
	if (!text && pendingThemeAttachments.length === 0) return;
	if (dchatThemeChatInput) dchatThemeChatInput.value = '';
	const themeAtts = pendingThemeAttachments;
	pendingThemeAttachments = [];
	renderThemeAttachmentChips();
	let userContent = text;
	for (const att of themeAtts.filter(a => a.kind === 'text')) {
		userContent += `\n\n--- File: ${att.name} ---\n${att.text}`;
	}
	const bubbleLabel = text + (themeAtts.length ? `\n\n📄 ${themeAtts.map(a => a.name).join(', ')}` : '');
	themeChatMessages.push({ role: 'user', content: userContent || '(attached files)' });
	appendThemeChatBubble('user', bubbleLabel || '(attached files)');
	themeChatLoading = true;
	if (dchatThemeChatSend) dchatThemeChatSend.disabled = true;
	appendThemeChatBubble('system', thinkingStatusText());
	renderChatToCanvas();
	try {
		let data;
		if (selectedBackend === 'ollama') {
			data = await callOllamaDirect(
				cachedPrompts?.themePrompt || '',
				themeChatMessages.map(m => ({ role: m.role, content: m.content })),
				selectedOllamaModel,
				4096
			);
		} else {
			const response = await fetch('/api/theme-chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: themeChatMessages.map(m => ({ role: m.role, content: m.content })),
					backend: selectedBackend
				})
			});
			const responseText = await response.text();
			try { data = JSON.parse(responseText); }
			catch { throw new Error(`Server returned non-JSON (${response.status}): ${responseText.slice(0, 120)}`); }
			if (!response.ok) throw new Error(data.error || `API error: ${response.status}`);
		}
		const rawText = data.content?.[0]?.text || data.content || 'No response';
		const raw = typeof rawText === 'string' ? rawText : (Array.isArray(rawText) ? rawText.map(p => p.text || '').join('') : String(rawText));
		themeChatMessages.push({ role: 'assistant', content: raw });
		const { displayText, themes } = parseThemeJsonBlocks(raw);
		// Remove "Thinking..." bubble
		if (dchatThemeChatMessages?.lastChild?.classList?.contains('system')) {
			dchatThemeChatMessages.lastChild.remove();
		}
		appendThemeChatBubble('assistant', displayText || '(theme applied)');
		if (themes.length > 0) {
			applyTheme(themes[themes.length - 1], { announce: true });
		}
	} catch (err) {
		if (dchatThemeChatMessages?.lastChild?.classList?.contains('system')) {
			dchatThemeChatMessages.lastChild.remove();
		}
		appendThemeChatBubble('system', `Error: ${err.message}`);
		updateStatus(`Theme chat error: ${err.message}`, 'error');
	} finally {
		themeChatLoading = false;
		if (dchatThemeChatSend) dchatThemeChatSend.disabled = false;
		renderChatToCanvas();
	}
}

async function bootSharedScene() {
	const route = parseShareRoute();
	if (route.displayOnly) applyDisplayOnlyMode();

	try {
		await new Promise((resolve) => {
			// Kick a refresh without blocking forever if Blob isn't configured.
			const p = fetch('/api/community-scenes')
				.then(res => res.json().then(data => ({ ok: res.ok, data })))
				.then(({ ok, data }) => {
					if (ok && !data.error) renderCommunitySceneList(data.scenes || []);
				})
				.catch(() => {})
				.finally(resolve);
			return p;
		});
	} catch {
		// ignore
	}

	if (!route.sceneId) return;

	try {
		updateStatus('Loading scene...', 'connecting');
		const sc = await loadCommunitySceneById(route.sceneId, { activate: true });
		document.title = sc.name ? `${sc.name} — GS For Anything` : 'GS For Anything';
		if (editorLink) editorLink.href = sc.editorUrl || `/e/${route.sceneId}`;
		updateStatus(route.displayOnly ? '' : `Loaded "${sc.name}"`, route.displayOnly ? '' : 'connected');
	} catch (err) {
		updateStatus(`Load error: ${err.message}`, 'error');
	}
}

if (shareDisplayOnly) {
	shareDisplayOnly.addEventListener('change', () => {
		if (shareUrlInput) shareUrlInput.value = currentShareUrl();
	});
}
if (shareCloseBtn) shareCloseBtn.addEventListener('click', hideShareModal);
if (shareCopyBtn) {
	shareCopyBtn.addEventListener('click', async () => {
		const url = currentShareUrl();
		const ok = await copyText(url);
		shareCopyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
		setTimeout(() => { if (shareCopyBtn) shareCopyBtn.textContent = 'Copy link'; }, 1500);
	});
}
if (shareModal) shareModal.addEventListener('click', (e) => { if (e.target === shareModal) hideShareModal(); });
if (renameCancelBtn) renameCancelBtn.addEventListener('click', hideRenameModal);
if (renameConfirmBtn) renameConfirmBtn.addEventListener('click', renameCommunityScene);
if (renameNameInput) {
	renameNameInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); renameCommunityScene(); }
	});
}
if (renameModal) renameModal.addEventListener('click', (e) => { if (e.target === renameModal) hideRenameModal(); });


exportScreenshotBtn.addEventListener('click', () => {
	pendingExportThumbnail = captureScreenshot();
	exportPreview.innerHTML = `<img src="${pendingExportThumbnail}" style="width:80px;height:80px;border-radius:8px;object-fit:cover;">`;
});
exportCancelBtn.addEventListener('click', hideExportModal);
exportConfirmBtn.addEventListener('click', doExport);
exportDownloadBtn.addEventListener('click', doDownloadExport);

// Scene Manager 3D Panel
function createScenePanel() {
	sceneCanvas = document.createElement('canvas');
	sceneCanvas.width = 384;
	sceneCanvas.height = 768;
	sceneContext = sceneCanvas.getContext('2d');

	sceneTexture = new THREE.CanvasTexture(sceneCanvas);
	sceneTexture.minFilter = THREE.LinearFilter;
	sceneTexture.magFilter = THREE.LinearFilter;

	const geometry = new THREE.PlaneGeometry(SCENE_PANEL_WIDTH, SCENE_PANEL_HEIGHT);
	const material = new THREE.MeshBasicMaterial({
		map: sceneTexture,
		transparent: true,
		side: THREE.DoubleSide
	});

	scenePanel = new THREE.Mesh(geometry, material);
	const sceneX = -(CHAT_PANEL_WIDTH / 2 + SCENE_PANEL_GAP + SCENE_PANEL_WIDTH / 2);
	scenePanel.position.set(sceneX, 1.4, -CHAT_PANEL_DISTANCE);
	scene.add(scenePanel);

	renderScenePanel();
}

// Mirrors the loaded-scenes list (canvas scene panel, VR-only) into the
// desktop Scenes tab: checkbox toggles active, × removes, thumbnail if any.
function renderDomSceneList() {
	if (!dchatSceneList) return;

	dchatSceneList.innerHTML = '';
	if (loadedScenes.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.textContent = 'No scenes loaded. Use Import File or Load Saved.';
		dchatSceneList.appendChild(empty);
	} else {
		for (let i = 0; i < loadedScenes.length; i++) {
			const sc = loadedScenes[i];
			const item = document.createElement('div');
			item.className = 'dchat-scene-item' + (sc.active ? ' active' : '');

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = sc.active;
			checkbox.addEventListener('change', () => {
				sc.active = checkbox.checked;
				rebuildSceneFromActive();
				renderScenePanel();
				notifyCodeEditorExternalChange();
			});

			const thumb = document.createElement('img');
			thumb.className = 'dchat-scene-thumb';
			if (sc.thumbnail) thumb.src = sc.thumbnail;

			const name = document.createElement('div');
			name.className = 'dchat-scene-name';
			name.textContent = sc.name;
			name.title = sc.name;

			const remove = document.createElement('button');
			remove.className = 'dchat-scene-remove';
			remove.textContent = '×';
			remove.title = 'Remove scene';
			remove.addEventListener('click', () => {
				loadedScenes.splice(i, 1);
				rebuildSceneFromActive();
				renderScenePanel();
				notifyCodeEditorExternalChange();
			});

			item.append(checkbox, thumb, name, remove);
			dchatSceneList.appendChild(item);
		}
	}

	const hasContent = loadedScenes.some(s => s.active) || executedCodeBlocks.length > 0;
	dchatExportCombinedMount.classList.toggle('visible', hasContent && loadedScenes.length > 0);
}

// Last clamp limits from renderScenePanel, so stick scrolling can tell when
// it is already at an end and skip the redraw + texture upload.
const _scenePanelMaxScroll = { scenes: Infinity, files: Infinity, code: Infinity };

function renderScenePanel({ dom = true } = {}) {
	// The desktop Scenes list only changes with the scenes themselves; stick
	// scrolling the XR panel passes dom:false so it isn't rebuilt per frame.
	if (dom) renderDomSceneList();
	if (!sceneContext) return;

	const ctx = sceneContext;
	const w = sceneCanvas.width;
	const h = sceneCanvas.height;

	ctx.clearRect(0, 0, w, h);

	// Background
	ctx.fillStyle = 'rgba(20, 20, 30, 0.92)';
	roundRect(ctx, 0, 0, w, h, 16);
	ctx.fill();

	// Header — title follows active section (Scenes / Files / Code / Community)
	const headerTitles = {
		scenes: 'Scenes',
		files: 'Files',
		code: 'Code',
		community: 'Community'
	};
	ctx.fillStyle = 'rgba(139, 92, 246, 0.3)';
	roundRect(ctx, 0, 0, w, 50, 16, true);
	ctx.fill();
	ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.fillStyle = '#ffffff';
	ctx.textAlign = 'center';
	ctx.fillText(headerTitles[scenePanelSubTab] || 'Scenes', w / 2, 35);

	// Top-level sub-tabs (Scenes | Files | Code | Community)
	const subTabButtons = SCENE_PANEL_SUB_TABS.map(t => ({
		...t,
		variant: scenePanelSubTab === t.id ? 'active' : 'inactiveToggle'
	}));
	// Same order as desktop tabs after Chat/Environment: Scenes · Files · Code · Community
	const subTabLayout = buildButtonLayout(subTabButtons, {
		width: w - 24, x: 12, y: 56, height: 36, perRow: 4, gap: 6
	});
	scenePanelSubTabBoxes = subTabLayout.boxes;
	scenePanelNestedTabBoxes = [];
	drawButtonsToCanvas(ctx, scenePanelSubTabBoxes, { fontSize: 12 });

	let contentTop = 56 + subTabLayout.totalHeight + 10;
	scenePanelButtonBoxes = [];

	if (scenePanelSubTab === 'scenes') {
		const btnLayout = buildButtonLayout(SCENES_BUTTONS_XR, {
			width: w - 24, x: 12, y: contentTop, height: 44, minWidth: 100, gap: 8
		});
		scenePanelButtonBoxes = btnLayout.boxes;
		drawButtonsToCanvas(ctx, scenePanelButtonBoxes, { fontSize: 15 });

		const sepY = contentTop + btnLayout.totalHeight + 8;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
		ctx.fillRect(12, sepY, w - 24, 1);

		const listTop = sepY + 8;
		scenePanelListTop = listTop;
		const itemH = 72;
		const listBottom = 688;
		const maxVisible = Math.floor((listBottom - listTop) / itemH);

		if (loadedScenes.length === 0) {
			ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
			ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
			ctx.textAlign = 'center';
			ctx.fillText('No scenes loaded', w / 2, listTop + 40);
			ctx.fillText('Tap Load to import', w / 2, listTop + 65);
		} else {
			const maxScroll = Math.max(0, loadedScenes.length - maxVisible);
			_scenePanelMaxScroll.scenes = maxScroll;
			sceneScrollOffset = Math.max(0, Math.min(sceneScrollOffset, maxScroll));

			for (let i = 0; i < maxVisible && (i + sceneScrollOffset) < loadedScenes.length; i++) {
				const sc = loadedScenes[i + sceneScrollOffset];
				const itemY = listTop + i * itemH;

				ctx.fillStyle = sc.active ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255, 255, 255, 0.03)';
				roundRect(ctx, 8, itemY, w - 16, itemH - 4, 8);
				ctx.fill();

				const chkX = 16, chkY = itemY + (itemH - 4) / 2 - 12;
				ctx.strokeStyle = sc.active ? '#6366f1' : 'rgba(255,255,255,0.3)';
				ctx.lineWidth = 2;
				roundRect(ctx, chkX, chkY, 24, 24, 4);
				ctx.stroke();
				if (sc.active) {
					ctx.fillStyle = '#6366f1';
					roundRect(ctx, chkX + 2, chkY + 2, 20, 20, 3);
					ctx.fill();
					ctx.strokeStyle = '#ffffff';
					ctx.lineWidth = 2.5;
					ctx.beginPath();
					ctx.moveTo(chkX + 6, chkY + 12);
					ctx.lineTo(chkX + 11, chkY + 18);
					ctx.lineTo(chkX + 19, chkY + 7);
					ctx.stroke();
				}

				const thumbX = 48, thumbY2 = itemY + 8, thumbSize = itemH - 20;
				if (sc._thumbImage) {
					ctx.drawImage(sc._thumbImage, thumbX, thumbY2, thumbSize, thumbSize);
				} else {
					ctx.fillStyle = 'rgba(255,255,255,0.08)';
					roundRect(ctx, thumbX, thumbY2, thumbSize, thumbSize, 6);
					ctx.fill();
					ctx.font = '10px sans-serif';
					ctx.fillStyle = 'rgba(255,255,255,0.25)';
					ctx.textAlign = 'center';
					ctx.fillText('No img', thumbX + thumbSize / 2, thumbY2 + thumbSize / 2 + 4);
				}

				ctx.textAlign = 'left';
				ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
				ctx.fillStyle = '#ffffff';
				const nameX = thumbX + thumbSize + 10;
				const maxNameW = w - nameX - 40;
				let dName = sc.name;
				while (ctx.measureText(dName).width > maxNameW && dName.length > 3) dName = dName.slice(0, -1);
				if (dName !== sc.name) dName += '\u2026';
				ctx.fillText(dName, nameX, itemY + itemH / 2 + 5);

				const xX = w - 36, xY = itemY + (itemH - 4) / 2 - 10;
				ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
				roundRect(ctx, xX, xY, 24, 24, 4);
				ctx.fill();
				ctx.font = 'bold 16px sans-serif';
				ctx.fillStyle = '#ef4444';
				ctx.textAlign = 'center';
				ctx.fillText('\u00d7', xX + 12, xY + 18);
			}

			if (sceneScrollOffset > 0) {
				ctx.fillStyle = 'rgba(255,255,255,0.3)';
				ctx.font = '14px sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText('\u25b2 more', w / 2, listTop - 4);
			}
			if (sceneScrollOffset < maxScroll) {
				ctx.fillStyle = 'rgba(255,255,255,0.3)';
				ctx.font = '14px sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText('\u25bc more', w / 2, listBottom + 14);
			}
		}

		const hasContent = loadedScenes.some(s => s.active) || executedCodeBlocks.length > 0;
		if (hasContent && loadedScenes.length > 0) {
			drawButtonsToCanvas(ctx, buildButtonLayout(EXPORT_COMBINED_BUTTON, {
				width: w - 24, x: 12, y: 700, height: 48, perRow: 1
			}).boxes, { fontSize: 18 });
		}
	} else if (scenePanelSubTab === 'files') {
		const btnLayout = buildButtonLayout(FILES_BUTTONS, {
			width: w - 24, x: 12, y: contentTop, height: 44, perRow: 2, gap: 8
		});
		scenePanelButtonBoxes = btnLayout.boxes;
		drawButtonsToCanvas(ctx, scenePanelButtonBoxes, { fontSize: 14 });

		const sepY = contentTop + btnLayout.totalHeight + 8;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
		ctx.fillRect(12, sepY, w - 24, 1);

		ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
		ctx.fillStyle = 'rgba(255,255,255,0.4)';
		ctx.textAlign = 'center';
		ctx.fillText('Context library for chat prompts', w / 2, sepY + 22);

		const listTop = sepY + 34;
		scenePanelListTop = listTop;
		const itemH = 56;
		const listBottom = h - 16;
		const maxVisible = Math.floor((listBottom - listTop) / itemH);
		const maxScroll = Math.max(0, contextLibrary.length - maxVisible);
		_scenePanelMaxScroll.files = maxScroll;
		filesScrollOffset = Math.max(0, Math.min(filesScrollOffset, maxScroll));

		if (contextLibrary.length === 0) {
			ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
			ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
			ctx.textAlign = 'center';
			ctx.fillText('No files yet', w / 2, listTop + 40);
			ctx.fillText('Upload images or text', w / 2, listTop + 62);
		} else {
			for (let i = 0; i < maxVisible && (i + filesScrollOffset) < contextLibrary.length; i++) {
				const rec = contextLibrary[i + filesScrollOffset];
				const itemY = listTop + i * itemH;

				ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
				roundRect(ctx, 8, itemY, w - 16, itemH - 4, 8);
				ctx.fill();

				ctx.textAlign = 'left';
				ctx.font = '18px sans-serif';
				ctx.fillStyle = '#ffffff';
				ctx.fillText(rec.kind === 'image' ? '🖼️' : '📄', 16, itemY + itemH / 2 + 6);

				ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
				const nameX = 44;
				const maxNameW = w - nameX - 80;
				let dName = rec.name || 'file';
				while (ctx.measureText(dName).width > maxNameW && dName.length > 3) dName = dName.slice(0, -1);
				if (dName !== rec.name) dName += '\u2026';
				ctx.fillText(dName, nameX, itemY + itemH / 2 - 4);
				ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
				ctx.fillStyle = 'rgba(255,255,255,0.4)';
				ctx.fillText(
					`${rec.kind === 'image' ? 'Image' : 'Text'} \u00b7 ${formatFileSize(rec.size || 0)}`,
					nameX, itemY + itemH / 2 + 14
				);

				const pillW = 64, pillH = itemH - 16, pillX = w - 16 - pillW, pillY = itemY + 8;
				ctx.fillStyle = 'rgba(239, 68, 68, 0.35)';
				roundRect(ctx, pillX, pillY, pillW, pillH, 8);
				ctx.fill();
				ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
				ctx.fillStyle = '#ffffff';
				ctx.textAlign = 'center';
				ctx.fillText('Remove', pillX + pillW / 2, pillY + pillH / 2 + 4);
			}
			if (filesScrollOffset > 0) {
				ctx.fillStyle = 'rgba(255,255,255,0.3)';
				ctx.font = '14px sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText('\u25b2 more', w / 2, listTop - 2);
			}
			if (filesScrollOffset < maxScroll) {
				ctx.fillStyle = 'rgba(255,255,255,0.3)';
				ctx.font = '14px sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText('\u25bc more', w / 2, listBottom - 2);
			}
		}
	} else if (scenePanelSubTab === 'code') {
		const liveOn = !!(dchatCodeLive && dchatCodeLive.checked);
		const codeBtns = CODE_BUTTONS.map(b => {
			if (b.id === 'codeLive') {
				return {
					...b,
					label: liveOn ? 'Live: On' : 'Live: Off',
					variant: liveOn ? 'active' : 'inactiveToggle'
				};
			}
			return { ...b };
		});
		const btnLayout = buildButtonLayout(codeBtns, {
			width: w - 24, x: 12, y: contentTop, height: 36, perRow: 2, gap: 6
		});
		scenePanelButtonBoxes = btnLayout.boxes;
		drawButtonsToCanvas(ctx, scenePanelButtonBoxes, { fontSize: 12 });

		const sepY = contentTop + btnLayout.totalHeight + 8;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
		ctx.fillRect(12, sepY, w - 24, 1);

		ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
		ctx.fillStyle = 'rgba(255,255,255,0.4)';
		ctx.textAlign = 'center';
		const statusTxt = (dchatCodeStatus && dchatCodeStatus.textContent) || (codeEditorDirty ? 'Edited' : 'Synced');
		ctx.fillText(`${statusTxt} \u00b7 KEYS edits code when this tab is open`, w / 2, sepY + 18);

		const listTop = sepY + 28;
		scenePanelListTop = listTop;
		const codeText = (dchatCodeEditor && dchatCodeEditor.value) || buildCodeEditorSource() || '';
		const codeLines = codeText.length ? codeText.split('\n') : ['// No vr-exec blocks yet — chat to generate, or type here'];
		const lineH = 18;
		const listBottom = h - 16;
		const maxVisible = Math.floor((listBottom - listTop) / lineH);
		const maxScroll = Math.max(0, codeLines.length - maxVisible);
		_scenePanelMaxScroll.code = maxScroll;
		codeScrollOffset = Math.max(0, Math.min(codeScrollOffset, maxScroll));

		ctx.fillStyle = 'rgba(0,0,0,0.25)';
		roundRect(ctx, 8, listTop - 4, w - 16, listBottom - listTop + 8, 8);
		ctx.fill();

		ctx.textAlign = 'left';
		ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
		// Monospace: truncate by character count instead of re-measuring the
		// line once per dropped character.
		const maxW = w - 52;
		const charW = ctx.measureText('MMMMMMMMMM').width / 10 || 8;
		const maxChars = Math.max(4, Math.floor(maxW / charW));
		for (let i = 0; i < maxVisible && (i + codeScrollOffset) < codeLines.length; i++) {
			const line = codeLines[i + codeScrollOffset];
			const y = listTop + i * lineH + 12;
			ctx.fillStyle = 'rgba(255,255,255,0.25)';
			ctx.fillText(String(i + codeScrollOffset + 1).padStart(3, ' '), 12, y);
			ctx.fillStyle = '#e5e7eb';
			let display = line.replace(/\t/g, '  ');
			if (display.length > maxChars) display = display.slice(0, maxChars - 1) + '\u2026';
			ctx.fillText(display, 44, y);
		}
		if (codeScrollOffset > 0) {
			ctx.fillStyle = 'rgba(255,255,255,0.3)';
			ctx.font = '12px sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText('\u25b2', w / 2, listTop - 6);
		}
		if (codeScrollOffset < maxScroll) {
			ctx.fillStyle = 'rgba(255,255,255,0.3)';
			ctx.font = '12px sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText('\u25bc', w / 2, listBottom + 2);
		}
	} else if (scenePanelSubTab === 'community') {
		// Nested Scenes | Themes (matches desktop Community tab)
		const nestedBtns = COMMUNITY_NESTED_TABS.map(t => ({
			...t,
			variant: communitySection === t.id ? 'active' : 'inactiveToggle'
		}));
		const nestedLayout = buildButtonLayout(nestedBtns, {
			width: w - 24, x: 12, y: contentTop, height: 32, perRow: 2, gap: 6
		});
		scenePanelNestedTabBoxes = nestedLayout.boxes;
		drawButtonsToCanvas(ctx, scenePanelNestedTabBoxes, { fontSize: 13 });
		contentTop += nestedLayout.totalHeight + 8;

		if (communitySection === 'themes') {
			const btnLayout = buildButtonLayout(THEME_BUTTONS, {
				width: w - 24, x: 12, y: contentTop, height: 40, perRow: 3, gap: 6
			});
			const rememberLayout = buildButtonLayout([{
				id: 'rememberTheme',
				label: rememberTheme ? '\u2611 Remember theme' : '\u2610 Remember theme',
				action: 'theme:toggleRemember',
				variant: rememberTheme ? 'active' : 'inactiveToggle'
			}], {
				width: w - 24,
				x: 12,
				y: contentTop + btnLayout.totalHeight + 6,
				height: 34,
				perRow: 1,
				gap: 6
			});
			scenePanelButtonBoxes = btnLayout.boxes.concat(rememberLayout.boxes);
			drawButtonsToCanvas(ctx, scenePanelButtonBoxes, { fontSize: 11 });

			const sepY = contentTop + btnLayout.totalHeight + 6 + rememberLayout.totalHeight + 8;
			ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
			ctx.fillRect(12, sepY, w - 24, 1);

			const listTop = sepY + 8;
			scenePanelListTop = listTop;
			const itemH = 64;
			const listBottom = h - 16;
			const maxVisible = Math.floor((listBottom - listTop) / itemH);

			if (communityThemesCache.length === 0) {
				ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
				ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
				ctx.textAlign = 'center';
				ctx.fillText('No community themes yet', w / 2, listTop + 40);
				ctx.fillText('Restyle in Chat \u2192 Theme', w / 2, listTop + 62);
			} else {
				for (let i = 0; i < maxVisible && i < communityThemesCache.length; i++) {
					const th = communityThemesCache[i];
					const itemY = listTop + i * itemH;

					ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
					roundRect(ctx, 8, itemY, w - 16, itemH - 4, 8);
					ctx.fill();

					ctx.textAlign = 'left';
					ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
					ctx.fillStyle = '#ffffff';
					const nameX = 16;
					const maxNameW = w - nameX - 80;
					let dName = th.name;
					while (ctx.measureText(dName).width > maxNameW && dName.length > 3) dName = dName.slice(0, -1);
					if (dName !== th.name) dName += '\u2026';
					ctx.fillText(dName, nameX, itemY + 22);

					const dateLine = communityDatesMetaText(th, { short: true });
					if (dateLine) {
						ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
						ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
						let dDate = dateLine;
						while (ctx.measureText(dDate).width > maxNameW && dDate.length > 3) dDate = dDate.slice(0, -1);
						if (dDate !== dateLine) dDate += '\u2026';
						ctx.fillText(dDate, nameX, itemY + 40);
					}

					const pillW = 60, pillH = itemH - 16, pillX = w - 16 - pillW, pillY = itemY + 8;
					ctx.fillStyle = 'rgba(16, 185, 129, 0.45)';
					roundRect(ctx, pillX, pillY, pillW, pillH, 8);
					ctx.fill();
					ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
					ctx.fillStyle = '#ffffff';
					ctx.textAlign = 'center';
					ctx.fillText('Apply', pillX + pillW / 2, pillY + pillH / 2 + 4);
				}
			}
		} else {
			const btnLayout = buildButtonLayout(COMMUNITY_BUTTONS, {
				width: w - 24, x: 12, y: contentTop, height: 44, perRow: 2, gap: 8
			});
			drawButtonsToCanvas(ctx, btnLayout.boxes, { fontSize: 14 });

			const modeY = contentTop + btnLayout.totalHeight + 8;
			const modeLayout = buildButtonLayout(communityLoadModeButtons(), {
				width: w - 24, x: 12, y: modeY, height: 34, perRow: 2, gap: 8
			});
			drawButtonsToCanvas(ctx, modeLayout.boxes, { fontSize: 12 });
			scenePanelButtonBoxes = btnLayout.boxes.concat(modeLayout.boxes);

			const hintY = modeY + modeLayout.totalHeight + 14;
			ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
			ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
			ctx.textAlign = 'center';
			ctx.fillText('Clear blanks the scene · Layer adds · no duplicate loads', w / 2, hintY);

			const sepY = hintY + 10;
			ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
			ctx.fillRect(12, sepY, w - 24, 1);

			const listTop = sepY + 8;
			scenePanelListTop = listTop;
			const itemH = 64;
			const listBottom = h - 16;
			const maxVisible = Math.floor((listBottom - listTop) / itemH);

			if (communityScenesCache.length === 0) {
				ctx.font = '16px -apple-system, BlinkMacSystemFont, sans-serif';
				ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
				ctx.textAlign = 'center';
				ctx.fillText('No community scenes yet', w / 2, listTop + 40);
			} else {
				for (let i = 0; i < maxVisible && i < communityScenesCache.length; i++) {
					const cs = communityScenesCache[i];
					const itemY = listTop + i * itemH;
					const rowKey = communitySceneKeyFrom(cs);
					const rowLoaded = rowKey && loadedScenes.some(s => s.communityKey === rowKey && s.active);

					ctx.fillStyle = rowLoaded ? 'rgba(99, 102, 241, 0.22)' : 'rgba(255, 255, 255, 0.03)';
					roundRect(ctx, 8, itemY, w - 16, itemH - 4, 8);
					ctx.fill();

					ctx.textAlign = 'left';
					ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
					ctx.fillStyle = '#ffffff';
					const nameX = 16;
					const maxNameW = w - nameX - 80;
					let dName = cs.name;
					while (ctx.measureText(dName).width > maxNameW && dName.length > 3) dName = dName.slice(0, -1);
					if (dName !== cs.name) dName += '\u2026';
					ctx.fillText(dName, nameX, itemY + 22);

					const dateLine = communityDatesMetaText(cs, { short: true });
					if (dateLine) {
						ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
						ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
						let dDate = dateLine;
						while (ctx.measureText(dDate).width > maxNameW && dDate.length > 3) dDate = dDate.slice(0, -1);
						if (dDate !== dateLine) dDate += '\u2026';
						ctx.fillText(dDate, nameX, itemY + 40);
					}

					const pillW = 60, pillH = itemH - 16, pillX = w - 16 - pillW, pillY = itemY + 8;
					ctx.fillStyle = '#f4f4f8';
					roundRect(ctx, pillX, pillY, pillW, pillH, 8);
					ctx.fill();
					ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
					ctx.fillStyle = '#12121a';
					ctx.textAlign = 'center';
					ctx.fillText('Load', pillX + pillW / 2, pillY + pillH / 2 + 4);
				}
			}
		}
	}

	ctx.textAlign = 'left';
	sceneTexture.needsUpdate = true;
}

function loadSceneThumbnails() {
	for (const sc of loadedScenes) {
		if (sc.thumbnail && !sc._thumbImage) {
			const img = new Image();
			img.onload = () => { sc._thumbImage = img; renderScenePanel(); };
			img.src = sc.thumbnail;
		}
	}
}

function handleScenePanelHit(uv) {
	const canvasW = sceneCanvas?.width || 384;
	const canvasH = sceneCanvas?.height || 768;
	const canvasX = uv.x * canvasW;
	const canvasY = (1 - uv.y) * canvasH;

	const subTabHit = hitTestButtons(scenePanelSubTabBoxes, canvasX, canvasY);
	if (subTabHit) {
		handleMenuAction(subTabHit.action);
		return;
	}

	const nestedHit = hitTestButtons(scenePanelNestedTabBoxes, canvasX, canvasY);
	if (nestedHit) {
		handleMenuAction(nestedHit.action);
		return;
	}

	const btnHit = hitTestButtons(scenePanelButtonBoxes, canvasX, canvasY);
	if (btnHit) {
		handleMenuAction(btnHit.action);
		return;
	}

	if (scenePanelSubTab === 'scenes') {
		const listTop = scenePanelListTop, itemH = 72, listBottom = 688;
		const maxVisible = Math.floor((listBottom - listTop) / itemH);
		if (canvasY >= listTop && canvasY < listTop + maxVisible * itemH) {
			const idx = Math.floor((canvasY - listTop) / itemH) + sceneScrollOffset;
			if (idx >= 0 && idx < loadedScenes.length) {
				if (canvasX >= canvasW - 36) {
					loadedScenes.splice(idx, 1);
					rebuildSceneFromActive();
					renderScenePanel();
					notifyCodeEditorExternalChange();
				} else if (canvasX < 48) {
					loadedScenes[idx].active = !loadedScenes[idx].active;
					rebuildSceneFromActive();
					renderScenePanel();
					notifyCodeEditorExternalChange();
				}
			}
			return;
		}
		const combHit = hitTestButtons(buildButtonLayout(EXPORT_COMBINED_BUTTON, {
			width: canvasW - 24, x: 12, y: 700, height: 48, perRow: 1
		}).boxes, canvasX, canvasY);
		if (combHit) handleMenuAction(combHit.action);
	} else if (scenePanelSubTab === 'files') {
		const listTop = scenePanelListTop, itemH = 56;
		const idx = Math.floor((canvasY - listTop) / itemH) + filesScrollOffset;
		if (canvasY >= listTop && idx >= 0 && idx < contextLibrary.length) {
			// Remove pill is on the right
			if (canvasX >= canvasW - 16 - 64) {
				removeLibraryFile(contextLibrary[idx].id);
			}
		}
	} else if (scenePanelSubTab === 'code') {
		// Code body is view/edit via keyboard; taps on list area are no-ops
	} else if (scenePanelSubTab === 'community') {
		const listTop = scenePanelListTop, itemH = 64;
		const idx = Math.floor((canvasY - listTop) / itemH);
		if (canvasY < listTop || idx < 0) return;
		if (communitySection === 'themes') {
			if (idx < communityThemesCache.length) applyCommunityTheme(communityThemesCache[idx]);
		} else if (idx < communityScenesCache.length) {
			loadCommunityScene(communityScenesCache[idx]).catch(() => {});
		}
	}
}

function handleChatPanelHit(uv) {
	const canvasX = uv.x * 1024;
	const canvasY = (1 - uv.y) * (chatCanvas?.height || 768);
	const rememberHit = hitTestButtons(chatThemeRememberBoxes, canvasX, canvasY);
	if (rememberHit) {
		handleMenuAction(rememberHit.action);
		return;
	}
	const subHit = hitTestButtons(chatPanelSubTabBoxes, canvasX, canvasY);
	if (subHit) handleMenuAction(subHit.action);
}

function deepestDesktopChatElement(x, y) {
	if (!desktopChat) return null;
	// Same answer as before (smallest visible box under the point, later
	// nodes win ties) but checks the cheap box first and only reads computed
	// style for boxes that contain the point, and skips the inside of any
	// overflow-clipping box the point is not in (scrolled-away code lines).
	let best = null;
	let bestArea = Infinity;
	const visit = (el) => {
		for (const child of el.children) {
			const r = child.getBoundingClientRect();
			const inside = r.width > 0 && r.height > 0 && x >= r.left && y >= r.top && x <= r.right && y <= r.bottom;
			let style = null;
			if (inside) {
				style = getComputedStyle(child);
				if (style.display !== 'none' && style.visibility !== 'hidden') {
					const area = r.width * r.height;
					if (area <= bestArea) {
						best = child;
						bestArea = area;
					}
				}
			}
			if (child.children.length === 0) continue;
			if (!inside && r.width > 0 && r.height > 0) {
				style = style || getComputedStyle(child);
				const ox = style.overflowX, oy = style.overflowY;
				if (ox !== 'visible' && oy !== 'visible') continue;
			}
			visit(child);
		}
	};
	visit(desktopChat);
	return best;
}

function isHtmlTextField(el) {
	if (!el) return false;
	if (el instanceof HTMLTextAreaElement) return true;
	if (el instanceof HTMLInputElement) {
		const skip = ['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'image', 'hidden'];
		return !skip.includes(el.type);
	}
	return false;
}

// Ray hit on the mirrored desktop menu: the mesh is a snapshot, so the click
// is forwarded to the same #desktop-chat node that was painted.
function forwardHtmlInCanvasClick(uv) {
	if (!desktopChat) return;
	const rect = desktopChat.getBoundingClientRect();
	if (rect.width < 2 || rect.height < 2) return;
	const x = rect.left + uv.x * rect.width;
	const y = rect.top + (1 - uv.y) * rect.height;
	const el = deepestDesktopChatElement(x, y);
	if (!el) return;
	// Minimizing would display:none the source and blank the mirror, with no
	// in-world control to bring it back (the reopen button is outside the element).
	if (el.closest('#desktop-chat-minimize')) return;

	const label = el.closest('label');
	let field = el.closest('input, textarea, select');
	if (!field && label) field = label.control || label.querySelector('input, textarea, select');
	if (field instanceof HTMLSelectElement && field.options.length > 0) {
		field.selectedIndex = (field.selectedIndex + 1) % field.options.length;
		field.dispatchEvent(new Event('change', { bubbles: true }));
	} else if (field instanceof HTMLInputElement && field.type === 'range') {
		const r = field.getBoundingClientRect();
		const t = r.width > 0 ? Math.min(1, Math.max(0, (x - r.left) / r.width)) : 0;
		const min = Number(field.min || 0);
		const max = Number(field.max || 100);
		field.value = String(min + t * (max - min));
		field.dispatchEvent(new Event('input', { bubbles: true }));
	} else if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
		if (field.type === 'radio') field.checked = true;
		else field.checked = !field.checked;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		field.dispatchEvent(new Event('change', { bubbles: true }));
	} else if (isHtmlTextField(field)) {
		htmlKeyboardForDom = true;
		keyboardCollapsed = false;
		try { field.focus({ preventScroll: true }); } catch { field.focus(); }
		applyXrPanelVisibility(xrSessionActive());
		layoutHtmlInCanvasPanel();
	} else {
		const actionEl = el.closest('button, a, label, [data-action], [role="button"]') || el;
		if (!isHtmlTextField(document.activeElement) || !desktopChat.contains(document.activeElement)) {
			htmlKeyboardForDom = false;
		}
		actionEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
		applyXrPanelVisibility(xrSessionActive());
		layoutHtmlInCanvasPanel();
	}
	tickHtmlInCanvas(true);
}

// ============================================================================
// XR Controller Input & Raycasting
// ============================================================================
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

function createControllerRay() {
	const rayLength = 5;
	const points = [
		new THREE.Vector3(0, 0, 0),
		new THREE.Vector3(0, 0, -rayLength)
	];
	const geometry = new THREE.BufferGeometry().setFromPoints(points);

	// Gradient ray: bright at hand, fades out
	const colors = new Float32Array([
		0.4, 0.4, 1.0,  // start: soft blue-indigo
		0.0, 0.0, 0.0   // end: fades to nothing
	]);
	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

	const material = new THREE.LineBasicMaterial({
		vertexColors: true,
		transparent: true,
		opacity: 0.6,
		blending: THREE.AdditiveBlending,
		depthWrite: false
	});

	return new THREE.Line(geometry, material);
}

// Small reticle dot at the end of the ray for aiming feedback
function createReticle() {
	const geometry = new THREE.RingGeometry(0.005, 0.012, 24);
	const material = new THREE.MeshBasicMaterial({
		color: 0x6366f1,
		transparent: true,
		opacity: 0.8,
		side: THREE.DoubleSide,
		depthTest: false
	});
	const ring = new THREE.Mesh(geometry, material);
	ring.visible = false;
	ring.renderOrder = MENU_RETICLE_RENDER_ORDER;
	scene.add(ring);
	// Cursor must paint after the panels (same layer, higher renderOrder) or
	// the depthTest:false panels would cover it.
	registerMenuRoot(ring, MENU_RETICLE_RENDER_ORDER);
	return ring;
}

const controllerRays = [];
const reticles = [];

function setupXRControllers() {
	for (let i = 0; i < 2; i++) {
		const controller = renderer.xr.getController(i);
		controller.addEventListener('selectstart', onXRSelectStart);
		controller.addEventListener('selectend', onXRSelectEnd);

		// Attach ray line to controller
		const ray = createControllerRay();
		controller.add(ray);
		controllerRays.push(ray);

		// Create a reticle for hit feedback
		reticles.push(createReticle());

		// Controllers ride under viewOffset (with the camera) so lay-down pitch
		// remaps hands with the headset; player still owns locomotion yaw/move.
		viewOffset.add(controller);
	}
}

const htmlScrollDrag = [null, null];
const HTML_SCROLL_DRAG_PX = 8;

function xrControllerIndex(controller) {
	for (let i = 0; i < 2; i++) {
		if (renderer.xr.getController(i) === controller) return i;
	}
	return -1;
}

function desktopChatPointFromUV(uv) {
	if (!desktopChat || !uv) return null;
	const rect = desktopChat.getBoundingClientRect();
	if (rect.width < 2 || rect.height < 2) return null;
	return {
		x: rect.left + uv.x * rect.width,
		y: rect.top + (1 - uv.y) * rect.height,
		localX: uv.x * rect.width,
		localY: (1 - uv.y) * rect.height
	};
}

// Nearest ancestor (including the hit node) that can actually scroll.
function scrollableDesktopAncestor(el) {
	let node = el;
	while (node && desktopChat && desktopChat.contains(node)) {
		if (node instanceof Element) {
			const style = getComputedStyle(node);
			const oy = style.overflowY;
			const ox = style.overflowX;
			const canY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight + 1;
			const canX = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && node.scrollWidth > node.clientWidth + 1;
			if (canY || canX) return { el: node, canX, canY };
		}
		if (node === desktopChat) break;
		node = node.parentElement;
	}
	return null;
}

// Trigger press on a scrollable part of the mirrored menu. Returns false when
// the point is not a scroller, so the caller clicks immediately instead.
function beginHtmlInCanvasScrollDrag(controllerIndex, uv) {
	const point = desktopChatPointFromUV(uv);
	if (!point) return false;
	const el = deepestDesktopChatElement(point.x, point.y);
	if (!el || el.closest('#desktop-chat-minimize')) return false;
	const scroll = scrollableDesktopAncestor(el);
	if (!scroll) return false;
	htmlScrollDrag[controllerIndex] = {
		uv: { x: uv.x, y: uv.y },
		scroller: scroll.el,
		canX: scroll.canX,
		canY: scroll.canY,
		startLocalX: point.localX,
		startLocalY: point.localY,
		originScrollLeft: scroll.el.scrollLeft,
		originScrollTop: scroll.el.scrollTop,
		moved: false
	};
	return true;
}

function moveHtmlInCanvasScrollDrag(controllerIndex, uv) {
	const drag = htmlScrollDrag[controllerIndex];
	if (!drag || !drag.scroller || !drag.scroller.isConnected) {
		htmlScrollDrag[controllerIndex] = null;
		return;
	}
	const point = desktopChatPointFromUV(uv);
	if (!point) return;
	const dx = point.localX - drag.startLocalX;
	const dy = point.localY - drag.startLocalY;
	if (!drag.moved && (Math.abs(dx) > HTML_SCROLL_DRAG_PX || Math.abs(dy) > HTML_SCROLL_DRAG_PX)) {
		drag.moved = true;
	}
	if (!drag.moved) return;
	// Grab the content: pointer motion moves the scrolled content with it.
	if (drag.canY) drag.scroller.scrollTop = drag.originScrollTop - dy;
	if (drag.canX) drag.scroller.scrollLeft = drag.originScrollLeft - dx;
	// Painted by the frame loop at most every HTML_PAINT_MIN_MS (was a full
	// synchronous repaint on every frame of the drag).
	markHtmlInCanvasDirty();
}

function endHtmlInCanvasScrollDrag(controllerIndex) {
	const drag = htmlScrollDrag[controllerIndex];
	if (!drag) return;
	htmlScrollDrag[controllerIndex] = null;
	if (!drag.moved) forwardHtmlInCanvasClick(drag.uv);
	else tickHtmlInCanvas(true);
}

function onXRSelectEnd(event) {
	const idx = xrControllerIndex(event.target);
	if (idx >= 0 && _surfacePressed[idx]) {
		const surface = _surfacePressed[idx];
		_surfacePressed[idx] = null;
		const hover = _surfaceHover[idx];
		if (hover && hover.surface === surface) dispatchSurfacePointer(surface, hover.uv, 'up', { pointerId: 10 + idx });
		else dispatchSurfacePointer(surface, { x: 0.5, y: 0.5 }, 'cancel', { pointerId: 10 + idx });
		return;
	}
	if (idx >= 0) endHtmlInCanvasScrollDrag(idx);
}

function onXRSelectStart(event) {
	const controller = event.target;
	// Trigger on a canvas surface the frame loop found in front of any window.
	const sIdx = xrControllerIndex(controller);
	if (sIdx >= 0 && _surfaceHover[sIdx]) {
		const { surface, uv } = _surfaceHover[sIdx];
		_surfacePressed[sIdx] = surface;
		dispatchSurfacePointer(surface, uv, 'down', { pointerId: 10 + sIdx, pressed: true });
		return;
	}

	tempMatrix.identity().extractRotation(controller.matrixWorld);
	raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

	// UI collapse toggle — head-locked, always available (even when collapsed).
	if (uiTogglePanel) {
		const tHits = raycaster.intersectObject(uiTogglePanel);
		if (tHits.length > 0) {
			toggleUi();
			return;
		}
	}
	// When collapsed, the panels are hidden — nothing else is interactable.
	if (uiCollapsed) return;

	// Chat center panel (Scene|Theme subtabs)
	if (htmlInCanvasPanel && htmlInCanvasPanel.visible) {
		const htmlHits = raycaster.intersectObject(htmlInCanvasPanel);
		if (htmlHits.length > 0 && htmlHits[0].uv) {
			// Scrollable regions drag with the trigger held. A press that doesn't
			// move still clicks through forwardHtmlInCanvasClick on selectend.
			// Anything else (buttons, fields, scroll controls) clicks immediately.
			const idx = xrControllerIndex(controller);
			if (idx >= 0 && beginHtmlInCanvasScrollDrag(idx, htmlHits[0].uv)) return;
			forwardHtmlInCanvasClick(htmlHits[0].uv);
			return;
		}
	}

	if (chatPanel && chatPanel.visible) {
		const chatHits = raycaster.intersectObject(chatPanel);
		if (chatHits.length > 0 && chatHits[0].uv) {
			handleChatPanelHit(chatHits[0].uv);
			return;
		}
	}

	// Check scene manager panel hit
	if (scenePanel && scenePanel.visible) {
		const sceneHits = raycaster.intersectObject(scenePanel);
		if (sceneHits.length > 0 && sceneHits[0].uv) {
			handleScenePanelHit(sceneHits[0].uv);
			return;
		}
	}

	// Check side panel hit first (toggle + color wheel)
	if (sidePanel && sidePanel.visible) {
		const sideHits = raycaster.intersectObject(sidePanel);
		if (sideHits.length > 0 && sideHits[0].uv) {
			handleSidePanelHit(sideHits[0].uv);
			return;
		}
	}

	// Check input panel hit: [input area][MIC][KEYS][Send]
	if (inputPanel && inputPanel.visible) {
		const intersects = raycaster.intersectObject(inputPanel);
		if (intersects.length > 0 && intersects[0].uv) {
			const L = inputPanelLayout();
			const cx = intersects[0].uv.x * L.W;
			if (cx >= L.sendX) {
				handleXRSend();
			} else if (cx >= L.kbdX && cx < L.kbdX + L.kbdW) {
				toggleKeyboard();
			} else if (cx >= L.micX && cx < L.micX + L.micW) {
				toggleMicAlwaysOn();
			}
			// The input area itself is a no-op in XR: text comes from the in-scene
			// keyboard or the mic, never from focusing the crash-prone DOM input.
			return;
		}
	}

	// Check virtual keyboard hit (only when it's showing)
	if (keyboardPanel && keyboardPanel.visible && !keyboardCollapsed) {
		const kbHits = raycaster.intersectObject(keyboardPanel);
		if (kbHits.length > 0 && kbHits[0].uv) {
			handleKeyboardHit(kbHits[0].uv);
			return;
		}
	}
}

function handleXRSend() {
	// When the Code left-panel is active, Enter on the XR keyboard inserts a
	// newline into the code buffer instead of sending chat (see dispatchKey).
	if (scenePanelSubTab === 'code') return;

	if (chatSection === 'prompt') {
		const line = inputText.trim();
		if (!line) return;
		const r = ChatPrompt.saveCustom(`${ChatPrompt.currentText().trimEnd()}\n\n${line}`);
		updateStatus(r.ok ? 'Added to the Scene chat prompt' : r.error, r.ok ? 'connected' : 'error');
		if (r.ok) {
			inputText = '';
			if (chatInput) chatInput.value = '';
			chatScrollOffset = 0; // show the new last line
		}
		renderInputToCanvas();
		renderChatToCanvas();
		return;
	}

	if (chatSection === 'theme') {
		const message = inputText.trim();
		if (!message && pendingThemeAttachments.length === 0) return;
		if (dchatThemeChatInput) dchatThemeChatInput.value = message;
		inputText = '';
		if (chatInput) chatInput.value = '';
		renderInputToCanvas();
		sendThemeChat().then(() => renderChatToCanvas());
		return;
	}

	const message = inputText.trim();
	if (message || pendingAttachments.length > 0) {
		sendMessage(message);
		chatInput.value = '';
		inputText = '';
		renderInputToCanvas();
	}
}

setupXRControllers();

// Sync DOM input to 3D input panel
chatInput.addEventListener('input', () => {
	inputText = chatInput.value;
	renderInputToCanvas();
});

// ============================================================================
// VR Code Execution Engine
// ============================================================================

/**
 * Parse Claude's response to extract vr-exec code blocks.
 * Returns display text (with code blocks replaced by markers) and the code blocks.
 */
function parseVrExecBlocks(text) {
	const codeBlocks = [];
	const displayText = text.replace(/```vr-exec\n([\s\S]*?)```/g, (match, code) => {
		codeBlocks.push(code.trim());
		return `[Executed code block ${codeBlocks.length}]`;
	});
	return { displayText: displayText.trim(), codeBlocks };
}

/**
 * Execute a code string with access to scene globals.
 * Runs as an AsyncFunction so vr-exec blocks can use top-level await.
 * Returns a Promise that resolves once the code finishes.
 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ----------------------------------------------------------------------------
// Per-block runtime tracking (powers state-preserving hot reload)
// ----------------------------------------------------------------------------
// Every block runs with a key ("block:3", "scene:<id>#0", ...) and a `gs`
// helper. While it runs we record what it creates: top-level scene objects,
// _vrAnimations callbacks, timers, rAFs, listeners, overlay elements and
// canvas/p5 surfaces. Hot reload can then tear down and re-run ONE block,
// carrying over runtime state:
//   gs.state            per-block object that survives hot reloads
//   window.gsState      shared object that survives hot reloads
//   gs.onUpdate(fn)     per-frame callback, replaced (not stacked) on reload
//   gs.on(target, type, fn, opts) / gs.onDispose(fn)  cleaned up on reload
//   gs.hot              true when this run is a hot reload
// Bare setTimeout / setInterval / requestAnimationFrame (and their clear/cancel
// functions) inside a block are block-scoped wrappers, so old timers stop.
// Full reset (clearUserObjects) wipes all of it, state included.
const BLOCK_PARAMS = ['THREE', 'scene', 'camera', 'renderer', 'document', 'hud', 'gs'];
const BLOCK_TIMER_PARAMS = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'];
const BLOCK_ATTRIBUTION_WAIT_MS = 5000;
const _blockRuntimes = new Map();   // key -> runtime of the live run
const _blockStates = new Map();     // key -> gs.state (survives hot reload)
let _adhocBlockSeq = 0;
let _blockQueue = Promise.resolve();
window.gsState = window.gsState || {};

/** Compile a block without running it. Throws SyntaxError for bad code. */
function compileVrBlock(code) {
	try {
		return { fn: new AsyncFunction(...BLOCK_PARAMS, ...BLOCK_TIMER_PARAMS, code), timers: true };
	} catch (err) {
		// The block may declare its own `const setTimeout` etc.; fall back to
		// plain globals for timers rather than refuse the block.
		const fn = new AsyncFunction(...BLOCK_PARAMS, code); // rethrows real syntax errors
		return { fn, timers: false };
	}
}

function liveUserRoots() {
	const out = [];
	for (const child of scene.children) {
		if (!systemObjectIds.has(child.uuid)) out.push(child);
	}
	if (typeof arPlacementRoot !== 'undefined' && arPlacementRoot) {
		for (const child of arPlacementRoot.children) {
			if (child === arPlacementMarker || systemObjectIds.has(child.uuid)) continue;
			out.push(child);
		}
	}
	return out;
}

function newBlockRuntime(key, code) {
	return {
		key, code, roots: [], anims: [], timeouts: new Set(), intervals: new Set(), rafs: new Set(),
		listeners: [], disposers: [], overlay: [], surfaces: [], spawn: new Map()
	};
}

function makeBlockApi(rt, hot) {
	if (!_blockStates.has(rt.key)) _blockStates.set(rt.key, {});
	const timers = {
		setTimeout(fn, ms, ...args) {
			const id = window.setTimeout(() => { rt.timeouts.delete(id); if (typeof fn === 'function') fn(...args); }, ms);
			rt.timeouts.add(id);
			return id;
		},
		setInterval(fn, ms, ...args) {
			const id = window.setInterval(fn, ms, ...args);
			rt.intervals.add(id);
			return id;
		},
		clearTimeout(id) { rt.timeouts.delete(id); window.clearTimeout(id); },
		clearInterval(id) { rt.intervals.delete(id); window.clearInterval(id); },
		requestAnimationFrame(fn) {
			const id = window.requestAnimationFrame((t) => { rt.rafs.delete(id); fn(t); });
			rt.rafs.add(id);
			return id;
		},
		cancelAnimationFrame(id) { rt.rafs.delete(id); window.cancelAnimationFrame(id); }
	};
	const gs = {
		key: rt.key,
		hot: !!hot,
		state: _blockStates.get(rt.key),
		onUpdate(fn) {
			if (typeof fn !== 'function') return fn;
			window._vrAnimations.push(fn);
			return fn;
		},
		on(target, type, fn, opts) {
			if (!target || typeof target.addEventListener !== 'function') return;
			target.addEventListener(type, fn, opts);
			rt.listeners.push([target, type, fn, opts]);
		},
		onDispose(fn) { if (typeof fn === 'function') rt.disposers.push(fn); },
		...timers
	};
	return { gs, timers };
}

function snapshotTransformKeyed(rt, visit) {
	const seen = new Map();
	rt.roots.forEach((root, i) => {
		root.traverse((obj) => {
			let key;
			if (obj.name) key = 'n:' + obj.name;
			else if (obj === root) key = 'i:' + i;
			else return;
			const n = seen.get(key) || 0;
			seen.set(key, n + 1);
			if (n) key += '#' + n;
			visit(key, obj);
		});
	});
}

function recordBlockSpawn(rt) {
	rt.spawn.clear();
	snapshotTransformKeyed(rt, (key, obj) => {
		rt.spawn.set(key, {
			pos: obj.position.clone(), quat: obj.quaternion.clone(), scale: obj.scale.clone(),
			vel: obj.userData && obj.userData.velocity && obj.userData.velocity.isVector3 ? obj.userData.velocity.clone() : null
		});
	});
}

function readAmmoVelocity(body) {
	try {
		const lv = body.getLinearVelocity(), av = body.getAngularVelocity();
		return { lin: [lv.x(), lv.y(), lv.z()], ang: [av.x(), av.y(), av.z()] };
	} catch { return null; }
}

/** Live transforms (and velocities) of everything a block created, keyed by
 *  object name (or root order for unnamed roots). */
function snapshotBlockState(rt) {
	const snap = new Map();
	snapshotTransformKeyed(rt, (key, obj) => {
		const body = obj.userData && obj.userData.physicsBody;
		snap.set(key, {
			pos: obj.position.clone(), quat: obj.quaternion.clone(), scale: obj.scale.clone(),
			vel: obj.userData && obj.userData.velocity && obj.userData.velocity.isVector3 ? obj.userData.velocity.clone() : null,
			body: body ? readAmmoVelocity(body) : null,
			spawn: rt.spawn.get(key) || null
		});
	});
	return snap;
}

function syncAmmoBodyToObject(obj, vel) {
	const body = obj.userData && obj.userData.physicsBody;
	if (!body || typeof body.getWorldTransform !== 'function') return;
	try {
		obj.updateWorldMatrix(true, false);
		const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
		obj.matrixWorld.decompose(p, q, sc);
		const t = body.getWorldTransform();
		t.getOrigin().setValue(p.x, p.y, p.z);
		const bq = t.getRotation();
		bq.setValue(q.x, q.y, q.z, q.w);
		t.setRotation(bq);
		const ms = body.getMotionState && body.getMotionState();
		if (ms && ms.setWorldTransform) ms.setWorldTransform(t);
		if (vel) {
			const lv = body.getLinearVelocity(); lv.setValue(vel.lin[0], vel.lin[1], vel.lin[2]); body.setLinearVelocity(lv);
			const av = body.getAngularVelocity(); av.setValue(vel.ang[0], vel.ang[1], vel.ang[2]); body.setAngularVelocity(av);
		}
		if (body.activate) body.activate();
	} catch (e) {
		console.warn('hot reload: could not re-sync physics body', e);
	}
}

/** Put runtime state back onto a block's new objects. A value is only carried
 *  over when the code's starting value is unchanged, so editing an object's
 *  start position in code still moves it. */
function restoreBlockState(snap, rt) {
	if (!snap || !snap.size) return 0;
	let restored = 0;
	snapshotTransformKeyed(rt, (key, obj) => {
		const old = snap.get(key);
		if (!old) return;
		const spawn = rt.spawn.get(key);
		const same = (a, b) => !!(a && b && a.equals(b));
		// Per axis, so editing only the start height keeps the runtime x/z.
		for (const axis of ['x', 'y', 'z']) {
			if (!old.spawn || !spawn || old.spawn.pos[axis] === spawn.pos[axis]) obj.position[axis] = old.pos[axis];
			if (!old.spawn || !spawn || old.spawn.scale[axis] === spawn.scale[axis]) obj.scale[axis] = old.scale[axis];
		}
		if (!old.spawn || !spawn || same(old.spawn.quat, spawn.quat)) obj.quaternion.copy(old.quat);
		const v = obj.userData && obj.userData.velocity;
		if (old.vel && v && v.isVector3 && (!old.spawn || !spawn || !old.spawn.vel || same(old.spawn.vel, spawn.vel))) v.copy(old.vel);
		syncAmmoBodyToObject(obj, old.body);
		restored++;
	});
	return restored;
}

/** Undo everything one block run created, leaving every other block alone. */
function teardownBlock(rt) {
	if (!rt) return;
	for (const fn of rt.disposers) { try { fn(); } catch (e) { console.warn('block dispose hook failed', e); } }
	for (const id of rt.timeouts) window.clearTimeout(id);
	for (const id of rt.intervals) window.clearInterval(id);
	for (const id of rt.rafs) window.cancelAnimationFrame(id);
	for (const [target, type, fn, opts] of rt.listeners) { try { target.removeEventListener(type, fn, opts); } catch { /* ignore */ } }
	if (rt.anims.length) {
		const drop = new Set(rt.anims);
		window._vrAnimations = window._vrAnimations.filter((f) => !drop.has(f));
	}
	for (const surf of rt.surfaces) { try { surf.dispose(); } catch (e) { console.warn('surface dispose failed', e); } }
	const world = window.physicsWorld;
	for (const root of rt.roots) {
		root.traverse((obj) => {
			const body = obj.userData && obj.userData.physicsBody;
			if (body && world && typeof world.removeRigidBody === 'function') {
				try { world.removeRigidBody(body); } catch { /* ignore */ }
			}
		});
		if (root.parent) root.parent.remove(root);
		disposeRecursive(root);
	}
	for (const el of rt.overlay) el.remove();
	if (_blockRuntimes.get(rt.key) === rt) _blockRuntimes.delete(rt.key);
}

/** Run one block with tracking. Runs are serialized so objects are attributed
 *  to the right block. */
function runTrackedBlock(code, key, { hot = false, compiled = null } = {}) {
	const job = _blockQueue.then(() => runTrackedBlockNow(code, key, { hot, compiled }));
	_blockQueue = job.then(() => {}, () => {});
	return job;
}

async function runTrackedBlockNow(code, key, { hot, compiled }) {
	const { fn, timers: useTimers } = compiled || compileVrBlock(code);
	const rt = newBlockRuntime(key, code);
	const rootsBefore = new Set(liveUserRoots());
	const animsBefore = new Set(window._vrAnimations);
	const surfacesBefore = new Set(gsSurfaces);
	const overlayRoot = document.getElementById('overlay-root');
	const overlayBefore = new Set(overlayRoot ? overlayRoot.children : []);
	const { gs, timers } = makeBlockApi(rt, hot);
	const args = [THREE, scene, camera, renderer, document, hud, gs];
	if (useTimers) args.push(...BLOCK_TIMER_PARAMS.map((n) => timers[n]));
	const finish = () => {
		reanchorStrayObjects();
		rt.roots = liveUserRoots().filter((r) => !rootsBefore.has(r));
		rt.anims = window._vrAnimations.filter((f) => !animsBefore.has(f));
		rt.surfaces = [...gsSurfaces].filter((sf) => !surfacesBefore.has(sf));
		rt.overlay = overlayRoot ? [...overlayRoot.children].filter((el) => !overlayBefore.has(el) && !systemOverlayIds.has(el.id)) : [];
		recordBlockSpawn(rt);
		_blockRuntimes.set(key, rt);
	};
	let run;
	try {
		run = Promise.resolve(fn(...args));
	} catch (err) {
		finish();
		throw err;
	}
	// A block that keeps awaiting (big model download) shouldn't hold up the
	// rest; attribute what it made so far and let it finish in the background.
	let timer = 0;
	const capped = new Promise((resolve) => { timer = window.setTimeout(() => resolve('timeout'), BLOCK_ATTRIBUTION_WAIT_MS); });
	try {
		const r = await Promise.race([run, capped]);
		if (r === 'timeout') run.finally(reanchorStrayObjects).catch(() => {});
	} finally {
		window.clearTimeout(timer);
		finish();
	}
	return rt;
}

/**
 * Run a vr-exec block. `key` identifies it for hot reload (session blocks are
 * "block:<index>", scene blocks "scene:<id>#<index>"); omit for one-off runs.
 */
function executeVrCode(code, key) {
	return runTrackedBlock(code, key || `adhoc:${++_adhocBlockSeq}`);
}

// Safety net: an object that ends up parented to the camera or to a UI panel
// would move/rotate with the user's view or the chat window. After each block we
// move any such stray back into the world, preserving its current world transform
// so it stays put in the room. Objects the model was *directed* to make
// head-locked go under `hud` (a child of the camera) and are left alone.
function reanchorStrayObjects() {
	const worldParent = getWorldContentParent();
	// Camera: strays follow the head; the intentional `hud` group is exempt.
	for (let i = camera.children.length - 1; i >= 0; i--) {
		const child = camera.children[i];
		if (child === hud) continue;
		worldParent.attach(child); // keep world transform; AR uses placement root
	}
	// UI panels never legitimately have child meshes, so anything parented to one
	// is a stray object that would ride along with the window — re-anchor it.
	const panels = [chatPanel, inputPanel, keyboardPanel, sidePanel, scenePanel];
	for (const panel of panels) {
		if (!panel) continue;
		for (let i = panel.children.length - 1; i >= 0; i--) {
			worldParent.attach(panel.children[i]);
		}
	}
	// While Walk-in-AR is active, also pull newly added scene-root content into
	// the draggable placement group so chat-generated objects stay with the scene.
	if (mobileXRMode === 'ar') adoptSceneContentIntoArPlacement();
}

const MAX_FIX_ATTEMPTS = 3;

/**
 * Attempt to fix a failing code block via the error-correction API.
 * Returns { success, code, error } — the final fixed code if successful.
 */
async function attemptAutoFix(failingCode, errorMessage, errorStack, blockKey) {
	const priorFixes = [];

	for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
		updateStatus(`Fixing code (attempt ${attempt}/${MAX_FIX_ATTEMPTS})...`, '');
		renderChatToCanvas();

		const thisFailingCode = attempt === 1 ? failingCode : priorFixes[priorFixes.length - 1].code;

		try {
			let data;
			if (selectedBackend === 'ollama') {
				// Built to match the server's /api/fix-code prompt exactly (see
				// server.js) - kept client-side too so no code/error content has
				// to transit the server just to reach the user's own local model.
				let userContent = `The following vr-exec code block failed to execute.\n\n`;
				userContent += `**Error:** \`${errorMessage}\`\n`;
				if (errorStack) userContent += `**Stack:** \`${errorStack}\`\n`;
				userContent += `**Attempt:** ${attempt} of ${MAX_FIX_ATTEMPTS}\n\n`;
				userContent += `**Failing code:**\n\`\`\`javascript\n${thisFailingCode}\n\`\`\`\n\n`;
				if (priorFixes.length > 0) {
					userContent += `**Previous fix attempts that also failed:**\n`;
					for (const fix of priorFixes) {
						userContent += `\nAttempt ${fix.attempt} error: \`${fix.error}\`\n`;
						userContent += `\`\`\`javascript\n${fix.code}\n\`\`\`\n`;
					}
					userContent += `\nThe prior fixes did not work. Try a different approach.\n`;
				}
				userContent += `\nFix this code. Return ONLY a single \`vr-exec\` code block.`;
				userContent += `\n\n${buildGsSettingsNote()}`;

				data = await callOllamaDirect(
					cachedPrompts?.fixCodePrompt || '',
					[{ role: 'user', content: userContent }],
					selectedOllamaModel,
					8192
				);
			} else {
				const response = await fetch('/api/fix-code', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						failingCode: thisFailingCode,
						errorMessage,
						errorStack,
						attempt,
						priorFixes,
						sceneContext: buildGsSettingsNote(),
						backend: selectedBackend
					})
				});

				const responseText = await response.text();
				try {
					data = JSON.parse(responseText);
				} catch (e) {
					throw new Error(`Fix API returned non-JSON: ${responseText.slice(0, 120)}`);
				}

				if (!response.ok) {
					throw new Error(data.error || `Fix API error: ${response.status}`);
				}
			}

			const fixedRaw = data.content[0]?.text || '';
			const { codeBlocks: fixedBlocks } = parseVrExecBlocks(fixedRaw);

			if (fixedBlocks.length === 0) {
				// The response didn't contain a vr-exec block — try extracting from plain code fences
				const plainMatch = fixedRaw.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
				if (plainMatch) {
					fixedBlocks.push(plainMatch[1].trim());
				}
			}

			if (fixedBlocks.length === 0) {
				throw new Error('Fix response contained no code block');
			}

			const fixedCode = fixedBlocks[0];

			// Try executing the fixed code
			try {
				await executeVrCode(fixedCode, blockKey);
				return { success: true, code: fixedCode, attempts: attempt };
			} catch (retryErr) {
				// This fix also failed — record it and try again
				errorMessage = retryErr.message;
				errorStack = retryErr.stack;
				priorFixes.push({ attempt, code: fixedCode, error: retryErr.message });
			}

		} catch (apiErr) {
			console.error(`Fix attempt ${attempt} API error:`, apiErr);
			return { success: false, code: null, error: apiErr.message, attempts: attempt };
		}
	}

	return {
		success: false,
		code: null,
		error: `Failed after ${MAX_FIX_ATTEMPTS} fix attempts. Last error: ${errorMessage}`,
		attempts: MAX_FIX_ATTEMPTS
	};
}

// ============================================================================
// Chat attachments (desktop only - images and text-ish files for context)
// ============================================================================
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024; // 6MB raw per file
const MAX_ATTACHMENTS = 4;
const TEXTY_FILE_EXT = /\.(txt|md|markdown|json|js|jsx|ts|tsx|py|csv|html|htm|css|xml|yaml|yml|log|c|cpp|h|hpp|java|go|rs|sh|sql|ini|toml)$/i;

function isTextyFile(file) {
	return file.type.startsWith('text/') || file.type === 'application/json' || TEXTY_FILE_EXT.test(file.name);
}

function readFileAsDataURL(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error || new Error('Read failed'));
		reader.readAsDataURL(file);
	});
}

function readFileAsText(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error || new Error('Read failed'));
		reader.readAsText(file);
	});
}

async function addAttachments(fileList) {
	for (const file of fileList) {
		if (pendingAttachments.length >= MAX_ATTACHMENTS) {
			updateStatus(`Only ${MAX_ATTACHMENTS} attachments at a time`, 'error');
			break;
		}
		if (file.size > MAX_ATTACHMENT_BYTES) {
			updateStatus(`"${file.name}" is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB)`, 'error');
			continue;
		}
		try {
			if (file.type.startsWith('image/')) {
				const dataUrl = await readFileAsDataURL(file);
				const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
				pendingAttachments.push({
					id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
					name: file.name,
					kind: 'image',
					mediaType: file.type,
					base64
				});
			} else if (isTextyFile(file)) {
				const text = await readFileAsText(file);
				pendingAttachments.push({
					id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
					name: file.name,
					kind: 'text',
					text
				});
			} else {
				updateStatus(`"${file.name}" isn't a supported type — images and text files only`, 'error');
			}
		} catch (err) {
			updateStatus(`Couldn't read "${file.name}": ${err.message}`, 'error');
		}
	}
	renderAttachmentChips();
}

function renderAttachmentChips() {
	if (!desktopAttachmentsRow) return;
	desktopAttachmentsRow.innerHTML = '';
	desktopAttachmentsRow.hidden = pendingAttachments.length === 0;
	for (const att of pendingAttachments) {
		const chip = document.createElement('div');
		chip.className = 'dchat-attachment-chip';

		const icon = document.createElement('span');
		icon.textContent = att.kind === 'image' ? '🖼️' : '📄';

		const name = document.createElement('span');
		name.className = 'dchat-attachment-name';
		name.textContent = att.name;
		name.title = att.name;

		const remove = document.createElement('button');
		remove.className = 'dchat-attachment-remove';
		remove.textContent = '×';
		remove.title = 'Remove';
		remove.addEventListener('click', () => {
			pendingAttachments = pendingAttachments.filter(a => a.id !== att.id);
			renderAttachmentChips();
		});

		chip.append(icon, name, remove);
		desktopAttachmentsRow.appendChild(chip);
	}
}

// ============================================================================
// Context Files library (Files tab) — persisted in IndexedDB, pickable from chat
// ============================================================================
const FILES_DB_NAME = 'carljr-context-files';
const FILES_STORE = 'files';
const MAX_LIBRARY_FILES = 40;

function formatFileSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openFilesDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(FILES_DB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(FILES_STORE)) {
				db.createObjectStore(FILES_STORE, { keyPath: 'id' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
	});
}

async function idbGetAllFiles() {
	const db = await openFilesDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FILES_STORE, 'readonly');
		const req = tx.objectStore(FILES_STORE).getAll();
		req.onsuccess = () => resolve(req.result || []);
		req.onerror = () => reject(req.error);
	});
}

async function idbPutFile(record) {
	const db = await openFilesDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FILES_STORE, 'readwrite');
		tx.objectStore(FILES_STORE).put(record);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function idbDeleteFile(id) {
	const db = await openFilesDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FILES_STORE, 'readwrite');
		tx.objectStore(FILES_STORE).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function idbClearFiles() {
	const db = await openFilesDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(FILES_STORE, 'readwrite');
		tx.objectStore(FILES_STORE).clear();
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

async function loadContextLibrary() {
	try {
		contextLibrary = await idbGetAllFiles();
		contextLibrary.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
	} catch (err) {
		console.warn('Context library load failed', err);
		contextLibrary = [];
	}
	renderContextFilesList();
}

function libraryRecordFromPendingShape(rec) {
	// pendingAttachments / library share { id, name, kind, ... }
	return {
		id: rec.id,
		name: rec.name,
		kind: rec.kind,
		mediaType: rec.mediaType || '',
		base64: rec.base64 || '',
		text: rec.text || '',
		size: rec.size || 0,
		addedAt: rec.addedAt || Date.now()
	};
}

function attachmentFromLibrary(rec) {
	const out = {
		id: rec.id + '-' + Math.random().toString(36).slice(2, 6),
		name: rec.name,
		kind: rec.kind,
		libraryId: rec.id
	};
	if (rec.kind === 'image') {
		out.mediaType = rec.mediaType;
		out.base64 = rec.base64;
	} else {
		out.text = rec.text;
	}
	return out;
}

async function addFilesToLibrary(fileList) {
	for (const file of fileList) {
		if (contextLibrary.length >= MAX_LIBRARY_FILES) {
			updateStatus(`Library full (max ${MAX_LIBRARY_FILES} files)`, 'error');
			break;
		}
		if (file.size > MAX_ATTACHMENT_BYTES) {
			updateStatus(`"${file.name}" is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB)`, 'error');
			continue;
		}
		try {
			let record;
			const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			if (file.type.startsWith('image/')) {
				const dataUrl = await readFileAsDataURL(file);
				const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
				record = {
					id, name: file.name, kind: 'image', mediaType: file.type,
					base64, text: '', size: file.size, addedAt: Date.now()
				};
			} else if (isTextyFile(file)) {
				const text = await readFileAsText(file);
				record = {
					id, name: file.name, kind: 'text', mediaType: file.type || 'text/plain',
					base64: '', text, size: file.size, addedAt: Date.now()
				};
			} else {
				updateStatus(`"${file.name}" isn't a supported type — images and text files only`, 'error');
				continue;
			}
			await idbPutFile(record);
			contextLibrary.unshift(record);
			updateStatus(`Added "${file.name}" to Files`, 'connected');
		} catch (err) {
			updateStatus(`Couldn't save "${file.name}": ${err.message}`, 'error');
		}
	}
	renderContextFilesList();
}

async function removeLibraryFile(id) {
	try {
		await idbDeleteFile(id);
	} catch (err) {
		updateStatus(`Couldn't remove file: ${err.message}`, 'error');
		return;
	}
	contextLibrary = contextLibrary.filter(f => f.id !== id);
	renderContextFilesList();
}

async function clearContextLibrary() {
	if (!contextLibrary.length) return;
	if (!window.confirm(`Remove all ${contextLibrary.length} files from the library?`)) return;
	try {
		await idbClearFiles();
		contextLibrary = [];
		renderContextFilesList();
		updateStatus('Files library cleared', 'connected');
	} catch (err) {
		updateStatus(`Clear failed: ${err.message}`, 'error');
	}
}

function renderContextFilesList() {
	if (scenePanelSubTab === 'files') renderScenePanel();
	if (!dchatFilesList) return;
	dchatFilesList.innerHTML = '';
	if (!contextLibrary.length) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.textContent = 'No files yet. Upload images or text to use as chat context.';
		dchatFilesList.appendChild(empty);
		return;
	}
	for (const rec of contextLibrary) {
		const item = document.createElement('div');
		item.className = 'dchat-file-item';

		const icon = document.createElement('span');
		icon.textContent = rec.kind === 'image' ? '🖼️' : '📄';

		const meta = document.createElement('div');
		meta.className = 'meta';
		const name = document.createElement('div');
		name.className = 'name';
		name.textContent = rec.name;
		name.title = rec.name;
		const sub = document.createElement('div');
		sub.className = 'sub';
		sub.textContent = `${rec.kind === 'image' ? 'Image' : 'Text'} · ${formatFileSize(rec.size || 0)}`;
		meta.append(name, sub);

		const remove = document.createElement('button');
		remove.className = 'dchat-btn';
		remove.textContent = 'Remove';
		remove.addEventListener('click', () => removeLibraryFile(rec.id));

		item.append(icon, meta, remove);
		dchatFilesList.appendChild(item);
	}
}

function renderThemeAttachmentChips() {
	if (!dchatThemeAttachmentsRow) return;
	dchatThemeAttachmentsRow.innerHTML = '';
	dchatThemeAttachmentsRow.hidden = pendingThemeAttachments.length === 0;
	for (const att of pendingThemeAttachments) {
		const chip = document.createElement('div');
		chip.className = 'dchat-attachment-chip';
		const icon = document.createElement('span');
		icon.textContent = att.kind === 'image' ? '🖼️' : '📄';
		const name = document.createElement('span');
		name.className = 'dchat-attachment-name';
		name.textContent = att.name;
		name.title = att.name;
		const remove = document.createElement('button');
		remove.className = 'dchat-attachment-remove';
		remove.textContent = '×';
		remove.title = 'Remove';
		remove.addEventListener('click', () => {
			pendingThemeAttachments = pendingThemeAttachments.filter(a => a.id !== att.id);
			renderThemeAttachmentChips();
		});
		chip.append(icon, name, remove);
		dchatThemeAttachmentsRow.appendChild(chip);
	}
}

function openFilesPicker(target) {
	filesPickerTarget = target === 'theme' ? 'theme' : 'scene';
	filesPickerSelected = new Set();
	if (!filesPickerModal || !filesPickerList) return;
	filesPickerList.innerHTML = '';
	if (!contextLibrary.length) {
		const empty = document.createElement('div');
		empty.className = 'dchat-scene-empty';
		empty.style.padding = '12px';
		empty.textContent = 'No files in the library yet. Open the Files tab to upload some.';
		filesPickerList.appendChild(empty);
	} else {
		for (const rec of contextLibrary) {
			const row = document.createElement('label');
			row.className = 'files-picker-row';
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.value = rec.id;
			cb.addEventListener('change', () => {
				if (cb.checked) filesPickerSelected.add(rec.id);
				else filesPickerSelected.delete(rec.id);
				row.classList.toggle('selected', cb.checked);
			});
			const label = document.createElement('div');
			label.className = 'label';
			const name = document.createElement('div');
			name.className = 'name';
			name.textContent = `${rec.kind === 'image' ? '🖼️' : '📄'} ${rec.name}`;
			const sub = document.createElement('div');
			sub.className = 'sub';
			sub.textContent = `${rec.kind === 'image' ? 'Image' : 'Text'} · ${formatFileSize(rec.size || 0)}`;
			label.append(name, sub);
			row.append(cb, label);
			filesPickerList.appendChild(row);
		}
	}
	filesPickerModal.classList.add('open');
	filesPickerModal.setAttribute('aria-hidden', 'false');
}

function closeFilesPicker() {
	if (!filesPickerModal) return;
	filesPickerModal.classList.remove('open');
	filesPickerModal.setAttribute('aria-hidden', 'true');
	filesPickerSelected = new Set();
}

function confirmFilesPicker() {
	const picked = contextLibrary.filter(f => filesPickerSelected.has(f.id));
	if (!picked.length) {
		closeFilesPicker();
		return;
	}
	if (filesPickerTarget === 'theme') {
		for (const rec of picked) {
			if (pendingThemeAttachments.length >= MAX_ATTACHMENTS) {
				updateStatus(`Only ${MAX_ATTACHMENTS} attachments at a time`, 'error');
				break;
			}
			// Theme API is text-only; skip images with a note
			if (rec.kind === 'image') {
				updateStatus(`Theme chat uses text files only — skipped "${rec.name}"`, 'error');
				continue;
			}
			if (pendingThemeAttachments.some(a => a.libraryId === rec.id || a.name === rec.name)) continue;
			pendingThemeAttachments.push(attachmentFromLibrary(rec));
		}
		renderThemeAttachmentChips();
	} else {
		for (const rec of picked) {
			if (pendingAttachments.length >= MAX_ATTACHMENTS) {
				updateStatus(`Only ${MAX_ATTACHMENTS} attachments at a time`, 'error');
				break;
			}
			if (pendingAttachments.some(a => a.libraryId === rec.id || (a.name === rec.name && a.kind === rec.kind))) continue;
			pendingAttachments.push(attachmentFromLibrary(rec));
		}
		renderAttachmentChips();
	}
	closeFilesPicker();
	updateStatus(`Added ${picked.length} file(s) to prompt`, 'connected');
}

// Shapes attached files into whatever the selected backend expects. Text
// files fold directly into the plain-text message (works identically for
// every backend); images need a backend-specific content shape, since
// Anthropic, OpenAI, and Ollama each represent an inline image differently.
function buildUserContent(userMessage, attachments, backend) {
	let text = userMessage;
	for (const att of attachments.filter(a => a.kind === 'text')) {
		text += `\n\n--- File: ${att.name} ---\n${att.text}`;
	}

	const images = attachments.filter(a => a.kind === 'image');
	if (images.length === 0) return { content: text };

	const provider = backendProvider(backend);
	if (provider === 'ollama') {
		// Ollama's /api/chat takes images as a separate per-message field
		// (raw base64, no "data:" prefix), not inline in content.
		return { content: text || '(see attached image)', images: images.map(a => a.base64) };
	}

	if (provider === 'openai') {
		const parts = [{ type: 'text', text: text || '(see attached image)' }];
		for (const att of images) {
			parts.push({ type: 'image_url', image_url: { url: `data:${att.mediaType};base64,${att.base64}` } });
		}
		return { content: parts };
	}

	// Claude models (Anthropic content-block shape)
	const parts = [{ type: 'text', text: text || '(see attached image)' }];
	for (const att of images) {
		parts.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.base64 } });
	}
	return { content: parts };
}

// ============================================================================
// Claude API Integration (via proxy server)
// ============================================================================
async function sendMessage(userMessage) {
	if (!userMessage.trim() && pendingAttachments.length === 0) return;

	// Fold attachments into this message, then clear the staging area - see
	// buildUserContent() for how each attachment kind/backend is shaped.
	const attachments = pendingAttachments;
	pendingAttachments = [];
	renderAttachmentChips();

	const { content: userContent, images: ollamaImages } = buildUserContent(userMessage, attachments, selectedBackend);
	const turnBackend = selectedBackend;
	const turnModel = getActiveModelDisplayName();
	GSContext.recordUserTurn({ text: userMessage, attachments, backend: turnBackend, model: turnModel });

	// Add user message to both arrays
	messages.push({ role: 'user', content: userContent, ...(ollamaImages ? { images: ollamaImages } : {}) });
	displayMessages.push({
		role: 'user',
		content: userMessage + (attachments.length > 0 ? `\n\n📎 ${attachments.map(a => a.name).join(', ')}` : '')
	});
	chatScrollOffset = 0; // auto-scroll to bottom on new message

	// Set loading state BEFORE rendering so the model-aware thinking indicator
	// is drawn immediately — otherwise it only appears on the next render (which
	// previously required a click/interaction to trigger).
	isLoading = true;
	sendButton.disabled = true;
	updateStatus('Sending...', '');
	renderChatToCanvas();

	try {
		let data;
		if (selectedBackend === 'ollama') {
			data = await callOllamaDirect(
				ChatPrompt.effectivePrompt() || cachedPrompts?.systemPrompt || '',
				withGsSettingsNote(messages.map(m => ({ role: m.role, content: m.content, ...(m.images ? { images: m.images } : {}) }))),
				selectedOllamaModel
			);
		} else {
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					// The editor settings note (Environment 2D/3D, Dependencies,
					// gamepad helper) rides on the newest user message only.
					messages: withGsSettingsNote(messages.map(m => ({
						role: m.role,
						content: m.content
					}))),
					backend: selectedBackend,
					// Custom Scene chat prompt from Chat → Prompt (omitted = default).
					...ChatPrompt.requestFields()
				})
			});

			// Read as text first to avoid opaque JSON parse errors
			const responseText = await response.text();
			try {
				data = JSON.parse(responseText);
			} catch (parseErr) {
				throw new Error(`Server returned non-JSON (${response.status}): ${responseText.slice(0, 120)}`);
			}

			if (!response.ok) {
				throw new Error(data.error || `API error: ${response.status}`);
			}
		}
		const rawText = data.content[0]?.text || 'No response';

		// Parse and execute any vr-exec code blocks
		const { displayText, codeBlocks } = parseVrExecBlocks(rawText);

		// Store raw text for API context, cleaned text for display
		messages.push({ role: 'assistant', content: rawText });
		displayMessages.push({ role: 'assistant', content: displayText });
		GSContext.recordAssistantTurn({ raw: rawText, display: displayText, backend: turnBackend, model: turnModel, codeBlockCount: codeBlocks.length });

		if (codeBlocks.length > 0) {
			let execCount = 0;
			let fixCount = 0;
			for (const code of codeBlocks) {
				const blockKey = sessionBlockKey(executedCodeBlocks.length);
				try {
					await executeVrCode(code, blockKey);
					executedCodeBlocks.push(code);
					execCount++;
				} catch (execErr) {
					console.error('vr-exec error:', execErr);
					displayMessages.push({
						role: 'assistant',
						content: `[Code error: ${execErr.message} — auto-fixing...]`
					});
					chatScrollOffset = 0;
					renderChatToCanvas();

					// Attempt auto-fix
					const fix = await attemptAutoFix(code, execErr.message, execErr.stack, blockKey);
					if (fix.success) {
						executedCodeBlocks.push(fix.code);
						execCount++;
						fixCount++;
						displayMessages.push({
							role: 'assistant',
							content: `[Fixed after ${fix.attempts} attempt${fix.attempts > 1 ? 's' : ''}]`
						});
						GSContext.recordNote(`[Code error: ${execErr.message}. Auto-fixed after ${fix.attempts} attempt${fix.attempts > 1 ? 's' : ''}; fixed code:]\n${fix.code}`);
					} else {
						displayMessages.push({
							role: 'assistant',
							content: `[Auto-fix failed: ${fix.error}]`
						});
						GSContext.recordNote(`[Code error: ${execErr.message}. Auto-fix failed: ${fix.error}]`);
					}
				}
			}
			if (execCount > 0) {
				const fixNote = fixCount > 0 ? ` (${fixCount} auto-fixed)` : '';
				updateStatus(`Connected — ran ${execCount} block${execCount > 1 ? 's' : ''}${fixNote}`, 'connected');
				notifyCodeEditorExternalChange();
			} else {
				updateStatus('Connected', 'connected');
			}
		} else {
			updateStatus('Connected', 'connected');
		}

	} catch (error) {
		console.error('Chat error:', error);
		updateStatus(`Error: ${error.message}`, 'error');
		const errMsg = `Error: ${error.message}`;
		messages.push({ role: 'assistant', content: errMsg });
		displayMessages.push({ role: 'assistant', content: errMsg });
		GSContext.recordAssistantTurn({ raw: errMsg, display: errMsg, backend: turnBackend, model: turnModel, error: true });
	} finally {
		isLoading = false;
		sendButton.disabled = false;
		chatScrollOffset = 0; // auto-scroll to bottom on response
		renderChatToCanvas();
	}
}

// Creation context (chat log + info log saved with scenes): see creationContext.js.
GSContext.initCreationContext({
	appVersion: GS_VERSION,
	getSettings: () => ({
		environment: { ...sceneEnv, lib: currentSceneLib() },
		dependencies: GS_DEPS ? GS_DEPS.list.map(d => ({ id: d.id, name: d.name, version: d.version, enabled: GS_DEPS.isEnabled(d.id) })) : [],
		backend: selectedBackend,
		model: getActiveModelDisplayName(),
		locomotion: locomotionMode
	}),
	getSettingsNote: () => buildGsSettingsNote(),
	getLibraryFiles: () => contextLibrary.map(f => ({ name: f.name, kind: f.kind, size: f.size || 0 })),
	getSceneName: () => loadedScenes.find(s => s.active)?.name || 'Current session',
	// Restored history goes into both arrays: `messages` is what the next
	// /api/chat request sends, `displayMessages` is drawn on desktop and in VR.
	appendChatHistory: (apiMsgs, displayMsgs) => {
		if (apiMsgs.length) {
			const last = messages[messages.length - 1];
			if (last && last.role === 'user') messages.push({ role: 'assistant', content: '(Continuing below with the creation history of a loaded scene.)' });
			messages.push(...apiMsgs);
		}
		displayMessages.push(...displayMsgs);
		chatScrollOffset = 0;
		renderChatToCanvas();
	},
	pushChatNote: (text) => {
		displayMessages.push({ role: 'assistant', content: text, history: true, historyMarker: true });
		chatScrollOffset = 0;
		renderChatToCanvas();
	},
	updateStatus: (t, c) => updateStatus(t, c),
	isXrActive: () => xrSessionActive() || !!mobileXRMode,
	isDisplayOnly: () => displayOnlyMode
});
window.GSContext = GSContext; // console / test access

// Community scene merge (see communityMerge.js). The AI call uses the same
// backend path as the scene chat; the result is installed as a new scene.
async function callSceneChatBackend(apiMessages) {
	if (selectedBackend === 'ollama') {
		const data = await callOllamaDirect(ChatPrompt.effectivePrompt() || cachedPrompts?.systemPrompt || '', withGsSettingsNote(apiMessages), selectedOllamaModel);
		return data.content[0]?.text || '';
	}
	const response = await fetch('/api/chat', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ messages: withGsSettingsNote(apiMessages), backend: selectedBackend, ...ChatPrompt.requestFields() })
	});
	const text = await response.text();
	let data;
	try { data = JSON.parse(text); } catch { throw new Error(`Server returned non-JSON (${response.status}): ${text.slice(0, 120)}`); }
	if (!response.ok) throw new Error(data.error || `API error: ${response.status}`);
	return data.content?.[0]?.text || '';
}

GSMerge.initCommunityMerge({
	getCommunityScenes: () => communityScenesCache,
	getModelSelect: () => desktopModelSelect,
	getModelLabel: () => getActiveModelDisplayName(),
	loadContext: (data) => GSContext.loadContextForScene(data),
	isDisplayOnly: () => displayOnlyMode,
	parseVrExecBlocks: (text) => parseVrExecBlocks(text),
	callChat: async (apiMessages) => {
		isLoading = true;
		renderChatToCanvas();
		try { return await callSceneChatBackend(apiMessages); } finally { isLoading = false; renderChatToCanvas(); }
	},
	// New working scene; neither original is touched. Failing blocks go
	// through the normal auto-fix (asset tokens keep base64 out of the fix call).
	installMergedScene: async ({ name, codeBlocks, mergedFrom, replaceWorld, tokenize, expand }) => {
		const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		if (replaceWorld) {
			if (executedCodeBlocks.length) {
				loadedScenes.push({ id: stamp(), name: 'Session before merge', thumbnail: '', codeBlocks: executedCodeBlocks.slice(), active: false, createdAt: new Date().toISOString(), _thumbImage: null });
			}
			blankLiveSceneForCommunityLoad();
		}
		const sc = { id: stamp(), name, thumbnail: '', codeBlocks: [], active: true, createdAt: new Date().toISOString(), _thumbImage: null, mergedFrom };
		loadedScenes.push(sc);
		let fixed = 0, failed = 0;
		for (const code of codeBlocks) {
			// Run under the scene's block key (PR #3 hot reload): the Code tab
			// then knows each block and won't re-run unchanged ones.
			const blockKey = sceneBlockKey(sc, sc.codeBlocks.length);
			try {
				await executeVrCode(code, blockKey);
				sc.codeBlocks.push(code);
			} catch (err) {
				console.error('merged block error:', err);
				teardownBlock(_blockRuntimes.get(blockKey)); // drop what the failed run made
				const fix = await attemptAutoFix(tokenize(code), err.message, err.stack, blockKey);
				if (fix.success) {
					const stored = expand(fix.code);
					sc.codeBlocks.push(stored);
					// The fix ran tokenized; record the stored text so hot reload sees it unchanged.
					const rt = _blockRuntimes.get(blockKey);
					if (rt) rt.code = stored;
					fixed++;
				}
				else {
					// Dropped: free the key so the next block starts clean.
					teardownBlock(_blockRuntimes.get(blockKey));
					_blockStates.delete(blockKey);
					failed++;
				}
			}
		}
		loadSceneThumbnails();
		renderScenePanel();
		notifyCodeEditorExternalChange();
		return { sceneId: sc.id, fixed, failed };
	},
	appendChat: (apiMsgs, displayMsgs) => {
		messages.push(...apiMsgs);
		displayMessages.push(...displayMsgs);
		chatScrollOffset = 0;
		renderChatToCanvas();
	},
	recordMerge: (info) => {
		GSContext.recordUserTurn({ text: info.userText, backend: selectedBackend, model: getActiveModelDisplayName() });
		GSContext.recordAssistantTurn({ raw: info.raw, display: info.display, backend: selectedBackend, model: getActiveModelDisplayName() });
		GSContext.recordMerge(info);
	},
	updateStatus: (t, c) => updateStatus(t, c)
});
window.GSMerge = GSMerge; // console / test access

function updateStatus(text, className) {
	// Keep the text/class on #status for anything that reads it. The element
	// stays hidden (see index.html); the head-locked HUD badge is not drawn.
	if (statusElement) {
		statusElement.textContent = text;
		statusElement.className = className || '';
	}
}

// ============================================================================
// Head-locked HUD status badge — not drawn.
// updateStatus() still records text on the hidden DOM #status element.
// ============================================================================
function createHudStatus() {
	// Intentionally does not add a mesh to `hud`.
}

function updateHudStatus() {
	if (hudStatusPanel) hudStatusPanel.visible = false;
}

// ============================================================================
// Collapse-all-UI toggle (head-locked button, works even when the UI is hidden)
// ============================================================================
function createUiToggle() {
	uiToggleCanvas = document.createElement('canvas');
	uiToggleCanvas.width = 384;
	uiToggleCanvas.height = 128;
	uiToggleContext = uiToggleCanvas.getContext('2d');

	uiToggleTexture = new THREE.CanvasTexture(uiToggleCanvas);
	uiToggleTexture.minFilter = THREE.LinearFilter;
	uiToggleTexture.magFilter = THREE.LinearFilter;

	const geo = new THREE.PlaneGeometry(0.14, 0.047);
	const mat = new THREE.MeshBasicMaterial({
		map: uiToggleTexture,
		transparent: true,
		depthTest: false,  // always drawn on top so it's reachable over any scene
		depthWrite: false
	});
	uiTogglePanel = new THREE.Mesh(geo, mat);
	// Head-locked, upper-right — always in reach even when the panels are hidden.
	uiTogglePanel.position.set(0.34, 0.2, -0.85);
	uiTogglePanel.renderOrder = 999;
	hud.add(uiTogglePanel);

	renderUiToggle();
}

function renderUiToggle() {
	if (!uiToggleContext) return;
	const ctx = uiToggleContext;
	const W = uiToggleCanvas.width;
	const H = uiToggleCanvas.height;

	ctx.clearRect(0, 0, W, H);
	ctx.fillStyle = uiCollapsed ? '#6366f1' : 'rgba(30, 30, 40, 0.9)';
	roundRect(ctx, 0, 0, W, H, 28);
	ctx.fill();

	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 44px -apple-system, BlinkMacSystemFont, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(uiCollapsed ? 'Show UI' : 'Hide UI', W / 2, H / 2 + 2);
	ctx.textAlign = 'left';
	ctx.textBaseline = 'alphabetic';

	uiToggleTexture.needsUpdate = true;
}

// Hide/show every main panel (3D) and the DOM chat overlay (windowed view). The
// head-locked toggle button stays visible so the UI can always be brought back.
function setUiCollapsed(collapsed) {
	if (displayOnlyMode) collapsed = true;
	uiCollapsed = collapsed;
	const immersive = renderer.xr.isPresenting;
	if (immersive) {
		applyXrPanelVisibility(true);
	} else {
		setDesktopChatMinimized(collapsed);
	}

	renderUiToggle();
	updateUiToggleDOM();
	updateStatus(collapsed ? 'UI hidden' : '', '');
}

function toggleUi() {
	setUiCollapsed(!uiCollapsed);
}

function updateUiToggleDOM() {
	const btn = document.getElementById('ui-toggle');
	if (btn) btn.textContent = uiCollapsed ? 'Show UI' : 'Hide UI';
}

// ============================================================================
// Locomotion (left thumbstick = move, right thumbstick = turn)
// ============================================================================
// Modes cycle Off → Planar → Free-roam:
//   • off    — thumbsticks scroll the canvas chat / scene list (not the HTML-in-canvas mirror).
//   • planar — left stick moves on the horizontal plane (in/out + strafe)
//              relative to camera yaw; no vertical from the left stick.
//   • free   — left stick uses the same level yaw translation; vertical
//              (right stick / Q/E) follows the camera's tilted local up.
// Right stick left/right yaws around world up (0, 1, 0), not the camera's tilted local up, in both movement modes, orbiting the camera world position so the view origin stays put.
const _locoQuat = new THREE.Quaternion();
const _locoRigQuat = new THREE.Quaternion();
const _locoForward = new THREE.Vector3();
const _locoRight = new THREE.Vector3();
const _locoMove = new THREE.Vector3();
const _locoHead = new THREE.Vector3();
const _LOCO_UP = new THREE.Vector3(0, 1, 0);

function cycleLocomotionMode() {
	locomotionMode = locomotionMode === 'off' ? 'planar'
		: locomotionMode === 'planar' ? 'free' : 'off';
	const label = locomotionMode === 'off' ? 'Locomotion off — thumbsticks scroll'
		: locomotionMode === 'planar' ? 'Locomotion: First Person (left move/turn · right stick turn/height)'
		: 'Locomotion: WASD/free-fly (left move/turn · right stick turn/height)';
	updateStatus(label, locomotionMode === 'off' ? '' : 'connected');
	// Keep the desktop dropdown in sync (it has no "off" option, so leave it
	// showing whichever nav type was last active if the VR grip cycled to off).
	if (dchatNavType && locomotionMode !== 'off') dchatNavType.value = locomotionMode;
}

dchatNavType?.addEventListener('change', () => {
	locomotionMode = dchatNavType.value;
});

const _locoUpLocal = new THREE.Vector3();

// Movement math for the VR thumbsticks and Cardboard hold-to-walk. mx/my
// are strafe/forward (-1..1, forward = negative my to match "push stick up
// = forward"), rx is yaw turn, ry is vertical (-1..1, positive = up).
// refCamera supplies the facing direction (xrCam in VR, `camera` in Cardboard).
//
// Both nav types: forward/back is the camera look direction with pitch
// removed (projected onto world XZ, so yaw around world up, level with the
// ground). Strafe is perpendicular to that level forward, also on XZ.
// Looking up or down does not fly you along the view ray.
// 'planar' (First Person): vertical (Q/E, right stick) is world up.
// 'free' (WASD): vertical is the camera's own local up, which tilts with pitch.
function applyLocomotionInput(dt, refCamera, mx, my, rx, ry) {
	if (!player || locomotionMode === 'off' || dt <= 0) return;

	if (mx !== 0 || my !== 0 || ry !== 0) {
		if (renderer.xr.isPresenting && viewOffset) {
			const xrCam = renderer.xr.getCamera();
			_locoQuat.copy(xrCam.quaternion);
			viewOffset.getWorldQuaternion(_locoRigQuat);
			_locoQuat.premultiply(_locoRigQuat);
		} else {
			refCamera.getWorldQuaternion(_locoQuat);
		}
		// View forward (camera local -Z), then pitch 0: keep only the XZ
		// projection so translation follows yaw, not look up/down.
		_locoForward.set(0, 0, -1).applyQuaternion(_locoQuat);
		const lookY = _locoForward.y;
		_locoForward.y = 0;
		if (_locoForward.lengthSq() < 1e-8) {
			// Look is parallel to world up, so the XZ projection vanished.
			// Camera up still carries yaw: it points opposite the heading
			// when looking up, and along the heading when looking down.
			_locoForward.set(0, 1, 0).applyQuaternion(_locoQuat);
			_locoForward.y = 0;
			if (lookY > 0) _locoForward.negate();
		}
		if (_locoForward.lengthSq() < 1e-8) _locoForward.set(0, 0, -1);
		_locoForward.normalize();
		// Level strafe: right = forward × worldUp (Y-up, camera looks down -Z).
		_locoRight.crossVectors(_locoForward, _LOCO_UP).normalize();
		let upVec;
		if (locomotionMode === 'planar') {
			upVec = _LOCO_UP; // global up - height is set by Q/E, unaffected by view direction
		} else {
			upVec = _locoUpLocal.set(0, 1, 0).applyQuaternion(_locoQuat); // local up - tilts with your view
		}
		_locoMove.set(0, 0, 0)
			.addScaledVector(_locoForward, -my) // push up = forward
			.addScaledVector(_locoRight, mx)    // push right = strafe right
			.addScaledVector(upVec, ry)          // Q/push right-stick up = ascend
			.multiplyScalar(MOVE_SPEED * dt);
		player.position.add(_locoMove);
	}

	// Turn (right stick x / no keyboard equivalent). Yaw around world up
	// (0, 1, 0), not the camera's tilted local up, orbiting the camera world
	// position so the view origin stays put and the rig turns around it.
	// Desktop never sends rx.
	if (rx !== 0) {
		const angle = -rx * TURN_SPEED * dt;
		camera.getWorldPosition(_locoHead);
		player.position.sub(_locoHead).applyAxisAngle(_LOCO_UP, angle).add(_locoHead);
		player.rotateOnWorldAxis(_LOCO_UP, angle);
	}
}

function updateLocomotion(dt, session) {
	if (!player || locomotionMode === 'off' || dt <= 0) return;

	const xrCam = renderer.xr.getCamera();
	let mx = 0, my = 0, rx = 0, ry = 0; // left x/y (move), right x (turn), right y (vertical)
	for (const source of session.inputSources) {
		const gp = source.gamepad;
		if (!gp || !gp.axes) continue;
		const axes = gp.axes;
		const ax = axes.length >= 4 ? axes[2] : (axes[0] || 0);
		const ay = axes.length >= 4 ? axes[3] : (axes[1] || 0);
		if (source.handedness === 'left') {
			// Direct mapping: previous transpose was wrong for Quest / current
			// OpenXR gamepads (strafe = horizontal, forward/back = vertical).
			if (Math.abs(ax) > THUMBSTICK_DEADZONE) mx = ax;
			if (Math.abs(ay) > THUMBSTICK_DEADZONE) my = ay;
		} else if (source.handedness === 'right') {
			if (Math.abs(ax) > THUMBSTICK_DEADZONE) rx = ax;
			// Right thumbstick vertical: push up to ascend (Q), pull down to
			// descend (E) - the flying-controls equivalent of Q/E.
			if (Math.abs(ay) > THUMBSTICK_DEADZONE) ry = -ay;
		}
	}

	applyLocomotionInput(dt, xrCam, mx, my, rx, ry);
}

// ============================================================================
// Controls tab: desktop/phone camera mode. The stock three.js controls from
// cameraControls.js, never used during an XR session or Cardboard (they drive
// the camera themselves) and disabled while typing into a text field.
//   orbit (default) OrbitControls around the scene origin · map MapControls ·
//   trackball TrackballControls · fly FlyControls · firstperson
//   PointerLockControls with the pointerlock example's WASD · off nothing.
// Saved values from 0.976 and earlier map orbit → orbit, free → firstperson,
// off → off.
// ============================================================================
const CAMERA_CONTROL_STORAGE_KEY = 'gs.cameraControlMode';

// Render distance: make the desktop/phone view draw everything VR draws.
// VR's far plane is RENDER_FAR metres from the headset, which starts at the
// player rig's eye (RENDER_EYE_HEIGHT above the rig). The windowed camera hangs
// in the same rig but usually not at the eye: it starts 4 m behind it, and
// Orbit / Map / Trackball zoom it further out while Fly / First person move it. With the same far value the
// desktop used to clip what VR still shows, so outside XR the far plane is
// pushed out by the camera's distance from the VR eye. With the camera at the
// eye that is exactly RENDER_FAR. VR and Cardboard use the far value as is.
// Near stays RENDER_NEAR everywhere.
// Scene code may still set camera.far / camera.near itself (e.g. a huge
// landscape). The new value then becomes the shared base for desktop and VR.
let renderFarBase = RENDER_FAR;
let renderFarApplied = RENDER_FAR;
const _renderEye = new THREE.Vector3();
const _renderCamPos = new THREE.Vector3();
function desktopRenderFarOffset() {
	if (renderer.xr.isPresenting || mobileXRMode || !player) return 0;
	player.updateWorldMatrix(true, false);
	_renderEye.set(0, RENDER_EYE_HEIGHT, 0);
	player.localToWorld(_renderEye);
	camera.getWorldPosition(_renderCamPos);
	return _renderCamPos.distanceTo(_renderEye);
}
function syncRenderDistance() {
	if (camera.far !== renderFarApplied) renderFarBase = camera.far; // changed by scene code
	const far = renderFarBase + desktopRenderFarOffset();
	if (far !== camera.far) {
		camera.far = far;
		camera.updateProjectionMatrix();
	}
	renderFarApplied = far;
}
window.gsRenderDistance = {
	get near() { return camera.near; },
	/** Far distance from the viewer in VR (and the desktop base). */
	get far() { return renderFarBase; },
	/** Far plane the windowed camera uses right now (base + offset from the VR eye). */
	get desktopFar() { return renderFarBase + desktopRenderFarOffset(); },
	defaults: { near: RENDER_NEAR, far: RENDER_FAR }
};

function cameraControlsSuspended() {
	return !!(renderer.xr.isPresenting || mobileXRMode);
}

const cameraControls = createCameraControls({
	camera,
	domElement: renderer.domElement,
	isSuspended: cameraControlsSuspended,
	onModeChange: () => renderCameraControlsUi(),
	onLockChange: (locked, why) => renderCameraControlsUi(why)
});

function refreshCameraControls() {
	cameraControls.refreshEnabled();
}

// The desktop controls move the camera inside the player rig; keep the rig at
// the origin so the camera's local pose is its world pose (and the Orbit
// target really is the scene origin).
function resetPlayerRig() {
	if (player) { player.position.set(0, 0, 0); player.rotation.set(0, 0, 0); }
	if (viewOffset) { viewOffset.position.set(0, 0, 0); viewOffset.rotation.set(0, 0, 0); }
}

// Reset Camera View / gamepad View / leaving VR or Cardboard: the default
// desktop view (camera at (0, 1.6, 4); Orbit, Map and Trackball look at the
// origin with their target there, Fly and First person face -Z).
function resetCameraView() {
	resetPlayerRig();
	cameraControls.reset();
}

// Orbit / Map / Trackball target, in world space (null in the other modes).
function orbitPivotWorld() {
	const t = cameraControls.target;
	if (!t) return null;
	const out = t.clone();
	if (camera.parent) { camera.parent.updateWorldMatrix(true, false); camera.parent.localToWorld(out); }
	return out;
}

// Clear scene and loading a scene put the Orbit / Map / Trackball target
// back on the scene origin if it was panned away.
function recenterOrbitPivot() {
	if (cameraControlsSuspended()) return;
	if (player && player.position.lengthSq() > 1e-8) resetPlayerRig();
	cameraControls.recenter();
}

// Compatible handles for scene code: gsOrbit (0.976) and window.controls (the
// name three.js examples use) both reach the active stock control.
window.gsOrbit = {
	/** World position the camera orbits (Orbit / Map / Trackball), else the origin. */
	pivot: () => (orbitPivotWorld() || ORBIT_TARGET.clone()).toArray(),
	recenter: () => recenterOrbitPivot()
};
window.gsControls = {
	modes: CAMERA_MODES.slice(),
	get mode() { return cameraControls.mode; },
	/** The active three.js controls instance (OrbitControls, MapControls, …) or null for Off. */
	get controls() { return cameraControls.controls; },
	setMode: (m) => setCameraControlMode(m),
	reset: () => resetCameraView()
};
{
	let userControls; // scene code may assign its own value
	Object.defineProperty(window, 'controls', {
		configurable: true,
		get() { return userControls !== undefined ? userControls : cameraControls.controls; },
		set(v) { userControls = v; }
	});
}

function renderCameraControlsUi(why) {
	const mode = cameraControls.mode;
	document.querySelectorAll('#dchat-camera-mode [data-camera-mode]').forEach((btn) => {
		const on = btn.dataset.cameraMode === mode;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', on ? 'true' : 'false');
	});
	document.querySelectorAll('[data-camera-help]').forEach((el) => {
		el.hidden = !el.dataset.cameraHelp.split(' ').includes(mode);
	});
	// PointerLockControls fires lock/unlock before it updates isLocked, so ask the document.
	const locked = mode === 'firstperson' && document.pointerLockElement === renderer.domElement;
	document.body.classList.toggle('gs-camera-locked', locked);
	const status = document.getElementById('dchat-controls-status');
	if (status) {
		status.textContent = mode === 'firstperson'
			? (locked ? 'Mouse look on. Press Esc to release.'
				: why === 'refused' ? 'The browser refused mouse look (Esc was just pressed). Click the scene again.' : '')
			: '';
	}
	window.gsRefreshTwinSticks?.(); // set up with the twin sticks further down
}

function setCameraControlMode(mode, { persist = true } = {}) {
	const prev = cameraControls.mode;
	resetPlayerRig();
	mode = cameraControls.setMode(mode);
	if (persist) {
		try { localStorage.setItem(CAMERA_CONTROL_STORAGE_KEY, mode); } catch { /* storage blocked */ }
	}
	renderCameraControlsUi();
	return prev;
}

document.querySelectorAll('#dchat-camera-mode [data-camera-mode]').forEach((btn) => {
	btn.addEventListener('click', () => setCameraControlMode(btn.dataset.cameraMode));
});

// A picked <select> option keeps keyboard focus (and would swallow the camera
// keys, since selects count as text entry); hand focus back to the page.
document.addEventListener('change', (e) => {
	if (e.target instanceof HTMLSelectElement) e.target.blur();
});

{
	let saved = null;
	try { saved = localStorage.getItem(CAMERA_CONTROL_STORAGE_KEY); } catch { /* storage blocked */ }
	const mode = normalizeCameraMode(saved);
	resetPlayerRig();
	camera.position.set(0, 1.6, 4);
	cameraControls.setMode(mode);
	cameraControls.reset();
	if (saved !== null && saved !== mode) {
		try { localStorage.setItem(CAMERA_CONTROL_STORAGE_KEY, mode); } catch { /* storage blocked */ }
	}
	renderCameraControlsUi();
}

// ============================================================================
// Environment (2D / 3D) + Dependencies (THREE.js / ammo.js / p5.js)
// ============================================================================
// The dependency loader itself lives in index.html (it has to run before this
// module so ammo.js is already downloading). This section adds:
//   - the Environment tab's 2D/3D choice (2D: p5.js | blank canvas,
//     3D: THREE.js | raw WebGL), saved in localStorage;
//   - the Dependencies tab (which libraries load on startup);
//   - buildGsSettingsNote(): the short "editor settings" note that is sent
//     with each chat request so the AI knows the chosen environment and the
//     libraries it may use (see sendMessage / attemptAutoFix).
// Scene code gets libraries with `await gsRequire('ammo' | 'p5' | 'three')`,
// so saved/shared scenes still work if a viewer has a library switched off.
const GS_DEPS = window.GS_DEPS || null;
if (GS_DEPS) GS_DEPS.modules.three = THREE;

const SCENE_ENV_STORAGE_KEY = 'gs.sceneEnvironment';
const SCENE_ENV_DEFAULT = { dim: '3d', lib2d: 'p5', lib3d: 'three' };
const SCENE_ENV_LIBS = { '2d': ['p5', 'canvas'], '3d': ['three', 'webgl'] };
let sceneEnv = { ...SCENE_ENV_DEFAULT };
try {
	const saved = JSON.parse(localStorage.getItem(SCENE_ENV_STORAGE_KEY) || 'null');
	if (saved && typeof saved === 'object') {
		if (saved.dim === '2d' || saved.dim === '3d') sceneEnv.dim = saved.dim;
		if (SCENE_ENV_LIBS['2d'].includes(saved.lib2d)) sceneEnv.lib2d = saved.lib2d;
		if (SCENE_ENV_LIBS['3d'].includes(saved.lib3d)) sceneEnv.lib3d = saved.lib3d;
	}
} catch { /* storage blocked or bad JSON: keep defaults */ }

function currentSceneLib() {
	return sceneEnv.dim === '2d' ? sceneEnv.lib2d : sceneEnv.lib3d;
}

const SCENE_ENV_NOTES = {
	p5: 'The AI writes p5.js sketches (instance mode) and shows them on a panel in the scene, so they also work in a headset. Turns p5.js on in Dependencies.',
	canvas: 'The AI draws with the plain HTML canvas 2D API on a panel in the scene, with no extra library.',
	three: 'The AI builds 3D scenes with THREE.js. This is the default.',
	webgl: 'The AI writes raw WebGL (its own shaders and buffers) on a canvas shown in the scene, instead of THREE.js meshes.'
};

function setSceneEnv(patch, { persist = true } = {}) {
	sceneEnv = { ...sceneEnv, ...patch };
	if (persist) {
		try { localStorage.setItem(SCENE_ENV_STORAGE_KEY, JSON.stringify(sceneEnv)); } catch { /* storage blocked */ }
	}
	// 2D -> p5.js needs p5 on the page: switch it on (and start loading it).
	if (sceneEnv.dim === '2d' && sceneEnv.lib2d === 'p5' && GS_DEPS && !GS_DEPS.isEnabled('p5')) {
		GS_DEPS.setEnabled('p5', true);
	}
	renderSceneEnvUi();
}

function renderSceneEnvUi() {
	document.querySelectorAll('#dchat-dim-mode [data-dim]').forEach((btn) => {
		const on = btn.dataset.dim === sceneEnv.dim;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', on ? 'true' : 'false');
	});
	const lib = currentSceneLib();
	document.querySelectorAll('#dchat-dim-sub [data-dim-lib]').forEach((btn) => {
		btn.hidden = btn.dataset.forDim !== sceneEnv.dim;
		const on = btn.dataset.dimLib === lib;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', on ? 'true' : 'false');
	});
	const note = document.getElementById('dchat-dim-note');
	if (note) note.textContent = SCENE_ENV_NOTES[lib] || '';
}

document.querySelectorAll('#dchat-dim-mode [data-dim]').forEach((btn) => {
	btn.addEventListener('click', () => setSceneEnv({ dim: btn.dataset.dim }));
});
document.querySelectorAll('#dchat-dim-sub [data-dim-lib]').forEach((btn) => {
	btn.addEventListener('click', () => {
		setSceneEnv(btn.dataset.forDim === '2d' ? { lib2d: btn.dataset.dimLib } : { lib3d: btn.dataset.dimLib });
	});
});

const DEP_STATUS_LABELS = { idle: 'Not loaded', loading: 'Loading…', loaded: 'Loaded', error: 'Failed to load' };

function escapeDepText(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDependenciesUi() {
	const list = document.getElementById('dchat-deps-list');
	if (!list || !GS_DEPS) return;
	list.innerHTML = GS_DEPS.list.map((d) => {
		const enabled = GS_DEPS.isEnabled(d.id);
		const state = GS_DEPS.status(d.id) || 'idle';
		const src = d.loadedFrom || d.src;
		const shownSrc = /^https?:/.test(src) ? src : new URL(src, location.href).pathname;
		return `<div class="dchat-dep" data-dep="${escapeDepText(d.id)}">
			<div class="dchat-dep-head">
				<span class="dchat-dep-name">${escapeDepText(d.name)}</span>
				<span class="dchat-dep-version">${escapeDepText(d.version)}</span>
				<label class="dchat-dep-toggle" title="${d.builtIn ? 'Always loaded' : 'Load on startup and tell the AI it can use this'}">
					<input type="checkbox" data-dep-toggle="${escapeDepText(d.id)}" ${enabled ? 'checked' : ''} ${d.builtIn ? 'disabled' : ''} />
					${d.builtIn ? 'Built in' : 'On'}
				</label>
			</div>
			<div class="dchat-dep-desc">${escapeDepText(d.description)}</div>
			<div class="dchat-dep-meta">
				<span class="dchat-dep-status" data-state="${state}">${DEP_STATUS_LABELS[state] || state}</span>
				<span>${escapeDepText(shownSrc)}</span>
				<a href="${escapeDepText(d.homepage)}" target="_blank" rel="noopener">Docs</a>
			</div>
		</div>`;
	}).join('');
	const note = document.getElementById('dchat-deps-note');
	if (note) {
		const offButLoaded = GS_DEPS.list.filter((d) => !GS_DEPS.isEnabled(d.id) && GS_DEPS.status(d.id) === 'loaded');
		note.textContent = offButLoaded.length
			? `${offButLoaded.map((d) => d.name).join(', ')} stays loaded until you reload the page.`
			: 'Turning a library off takes effect on the next page load.';
	}
}

document.getElementById('dchat-deps-list')?.addEventListener('change', (e) => {
	const input = e.target.closest('[data-dep-toggle]');
	if (!input || !GS_DEPS) return;
	GS_DEPS.setEnabled(input.dataset.depToggle, input.checked);
});
if (GS_DEPS) GS_DEPS.onChange(renderDependenciesUi);
renderDependenciesUi();
renderSceneEnvUi();
if (sceneEnv.dim === '2d' && sceneEnv.lib2d === 'p5') setSceneEnv({}, { persist: false });

// Canvas surfaces: a <canvas> shown on a plane in the 3D scene so 2D (p5 /
// canvas) and raw-WebGL content is visible on desktop, phone and in a
// headset alike. The texture is re-uploaded every frame.
function gsCreateCanvasSurface(opts = {}) {
	const {
		width = 1024,
		height = 768,
		context = '2d',
		contextAttributes = {},
		widthMeters = 1.6,
		position = [0, 1.4, -2],
		name = 'gs-canvas-surface',
		addToScene = true
	} = opts;
	const canvas = opts.canvas || document.createElement('canvas');
	if (!opts.canvas) { canvas.width = width; canvas.height = height; }
	let ctx = null;
	if (context) {
		// preserveDrawingBuffer: the texture upload may happen after the
		// browser has presented the WebGL canvas, which would otherwise be blank.
		const attrs = context === '2d' ? contextAttributes : { preserveDrawingBuffer: true, antialias: true, ...contextAttributes };
		ctx = canvas.getContext(context, attrs);
		if (!ctx) throw new Error(`Could not create a "${context}" canvas context`);
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
	mesh.name = name;
	mesh.position.set(position[0] || 0, position[1] || 0, position[2] || 0);
	const surface = {
		canvas, ctx, gl: context && context !== '2d' ? ctx : null, mesh, texture,
		autoUpdate: true,
		widthMeters,
		_aspect: 0,
		setSource(nextCanvas) {
			if (!nextCanvas || surface.canvas === nextCanvas) return;
			surface.canvas = nextCanvas;
			texture.image = nextCanvas;
			texture.needsUpdate = true;
		},
		update() {
			const c = surface.canvas;
			if (!c || !c.width || !c.height) return;
			const aspect = c.height / c.width;
			if (aspect !== surface._aspect) {
				surface._aspect = aspect;
				mesh.scale.set(surface.widthMeters, surface.widthMeters * aspect, 1);
			}
			if (surface.autoUpdate) texture.needsUpdate = true;
		},
		dispose() {
			gsSurfaces.delete(surface);
			const i = window._vrAnimations.indexOf(surface._tick);
			if (i >= 0) window._vrAnimations.splice(i, 1);
			if (surface.p5) { try { surface.p5.remove(); } catch { /* already removed */ } }
			surface.host?.remove();
			mesh.parent?.remove(mesh);
			mesh.geometry.dispose();
			material.dispose();
			texture.dispose();
		}
	};
	surface._tick = () => surface.update();
	surface.update();
	window._vrAnimations.push(surface._tick);
	gsSurfaces.add(surface);
	if (addToScene) getWorldContentParent().add(mesh);
	return surface;
}

// p5.js sketch (instance mode) shown on a canvas surface. p5 normally drives
// itself with window.requestAnimationFrame, which stops during an immersive
// XR session, so the app's render loop calls p.redraw() instead.
async function gsCreateP5Surface(sketch, opts = {}) {
	if (typeof sketch !== 'function') throw new Error('gsCreateP5Surface(sketch): sketch must be a function (p) => { p.setup = ...; p.draw = ... }');
	if (typeof window.gsRequire !== 'function') throw new Error('gsRequire is unavailable (dependency loader missing from index.html)');
	const P5 = await window.gsRequire('p5');
	const host = document.createElement('div');
	host.className = 'gs-p5-host';
	host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
	document.body.appendChild(host);
	const placeholder = document.createElement('canvas');
	placeholder.width = opts.width || 800;
	placeholder.height = opts.height || 600;
	const surface = gsCreateCanvasSurface({ ...opts, canvas: placeholder, context: null, name: opts.name || 'gs-p5-surface' });
	surface.host = host;
	surface.looping = true;
	let lastTime = 0;
	const wrapped = (p) => {
		const nativeNoLoop = p.noLoop.bind(p);
		p.loop = () => { surface.looping = true; };
		p.noLoop = () => { surface.looping = false; };
		sketch(p);
		nativeNoLoop(); // p5 draws once after setup, then the app drives frames
	};
	const instance = new P5(wrapped, host);
	surface.p5 = instance;
	const baseTick = surface._tick;
	surface._tick = (time) => {
		if (instance.canvas && surface.canvas !== instance.canvas) surface.setSource(instance.canvas);
		if (surface.looping && instance._setupDone !== false && typeof instance.draw === 'function') {
			const t = typeof time === 'number' ? time : performance.now();
			instance.deltaTime = lastTime ? t - lastTime : 16.7;
			lastTime = t;
			try { instance.redraw(); } catch (e) { console.error('p5 sketch error:', e); surface.looping = false; }
		}
		baseTick();
	};
	const i = window._vrAnimations.indexOf(baseTick);
	if (i >= 0) window._vrAnimations[i] = surface._tick;
	return surface;
}

window.gsCreateCanvasSurface = gsCreateCanvasSurface;

// ----------------------------------------------------------------------------
// Pointer input for canvas surfaces (p5 sketches and blank canvases)
// ----------------------------------------------------------------------------
// A controller ray (or a Quest hand's pinch ray), a desktop mouse or a phone
// touch on a surface mesh is turned into pointer + mouse events on the
// surface's canvas, at the matching canvas pixel. p5 listens on window and
// computes mouseX/mouseY from the canvas's client rect, so the events carry
// clientX/clientY in that rect (the p5 host is laid out off-screen); a canvas
// that isn't in the document gets canvas-pixel clientX/offsetX instead.
// This only reads the surface; the per-frame texture upload is untouched.
const _surfaceRaycaster = new THREE.Raycaster();
const _surfaceMeshes = [];
const _surfaceHover = [null, null];     // per XR controller: { surface, uv }
const _surfacePressed = [null, null];   // per XR controller: surface held by the trigger

function surfaceForMesh(mesh) {
	for (const sf of gsSurfaces) if (sf.mesh === mesh) return sf;
	return null;
}

/** First canvas-surface hit along the raycaster's ray, or null. */
function intersectCanvasSurfaces(raycaster) {
	if (!gsSurfaces.size) return null;
	_surfaceMeshes.length = 0;
	for (const sf of gsSurfaces) {
		const m = sf.mesh;
		if (m && m.parent && m.visible) _surfaceMeshes.push(m);
	}
	if (!_surfaceMeshes.length) return null;
	const hits = raycaster.intersectObjects(_surfaceMeshes, false);
	for (const h of hits) {
		if (!h.uv) continue;
		const surface = surfaceForMesh(h.object);
		if (surface) return { surface, uv: h.uv.clone(), point: h.point, face: h.face, distance: h.distance };
	}
	return null;
}

function dispatchSurfacePointer(surface, uv, type, { pointerId = 1, pressed = false } = {}) {
	const canvas = surface && surface.canvas;
	if (!canvas || !uv) return;
	const u = Math.min(1, Math.max(0, uv.x));
	const v = Math.min(1, Math.max(0, 1 - uv.y));
	const rect = canvas.isConnected ? canvas.getBoundingClientRect() : null;
	let clientX, clientY, offsetX, offsetY;
	if (rect && rect.width > 0 && rect.height > 0) {
		offsetX = u * rect.width;
		offsetY = v * rect.height;
		clientX = rect.left + offsetX;
		clientY = rect.top + offsetY;
	} else {
		offsetX = clientX = u * canvas.width;
		offsetY = clientY = v * canvas.height;
	}
	const buttons = pressed ? 1 : 0;
	const init = {
		bubbles: true, cancelable: true, composed: true, view: window,
		clientX, clientY, screenX: clientX, screenY: clientY, button: 0, buttons
	};
	const fire = (ev) => {
		Object.defineProperty(ev, 'offsetX', { value: offsetX });
		Object.defineProperty(ev, 'offsetY', { value: offsetY });
		canvas.dispatchEvent(ev);
	};
	const pointer = (t) => fire(new PointerEvent(t, { ...init, pointerId, pointerType: 'mouse', isPrimary: true, pressure: pressed ? 0.5 : 0 }));
	const mouse = (t) => fire(new MouseEvent(t, init));
	if (type === 'move') { pointer('pointermove'); mouse('mousemove'); }
	else if (type === 'down') { pointer('pointerdown'); mouse('mousedown'); }
	else if (type === 'up') { pointer('pointerup'); mouse('mouseup'); mouse('click'); }
	else if (type === 'cancel') { pointer('pointerup'); mouse('mouseup'); }
}

/**
 * One XR controller's ray vs the canvas surfaces. A window hit that is closer
 * wins (returns null). Sends pointermove when the hit pixel changes and puts
 * the reticle on the sketch as a small white dot.
 */
function updateSurfacePointer(i, rayOrigin, rayDir, uiIntersects, reticle) {
	// Surfaces are world content, so they stay clickable with the UI hidden.
	let surfHit = null;
	if (gsSurfaces.size) {
		_surfaceRaycaster.set(rayOrigin, rayDir);
		surfHit = intersectCanvasSurfaces(_surfaceRaycaster);
		if (surfHit && uiIntersects.length > 0 && uiIntersects[0].distance <= surfHit.distance) surfHit = null;
	}
	const pressedSurface = _surfacePressed[i];
	if (surfHit && (!pressedSurface || surfHit.surface === pressedSurface)) {
		const prev = _surfaceHover[i];
		if (!prev || prev.surface !== surfHit.surface || !prev.uv.equals(surfHit.uv)) {
			dispatchSurfacePointer(surfHit.surface, surfHit.uv, 'move', { pointerId: 10 + i, pressed: !!pressedSurface });
		}
		_surfaceHover[i] = { surface: surfHit.surface, uv: surfHit.uv };
	} else if (!pressedSurface) {
		_surfaceHover[i] = null;
	}
	if (surfHit && reticle) {
		reticle.position.copy(surfHit.point);
		_tmpSurfNormal.copy(surfHit.face.normal).transformDirection(surfHit.surface.mesh.matrixWorld);
		if (_tmpSurfNormal.dot(rayDir) > 0) _tmpSurfNormal.negate();
		reticle.lookAt(surfHit.point.x + _tmpSurfNormal.x, surfHit.point.y + _tmpSurfNormal.y, surfHit.point.z + _tmpSurfNormal.z);
		reticle.material.color.setHex(0xffffff);
		reticle.visible = true;
	}
	return surfHit;
}
const _tmpSurfNormal = new THREE.Vector3();

// Desktop mouse / phone touch on a surface in the 3D view. Capture phase on
// the WebGL canvas so a press that lands on a sketch doesn't also orbit.
const _surfaceNdc = new THREE.Vector2();
let _desktopSurfaceDrag = null; // { surface, pointerId }
function desktopSurfaceHit(e) {
	if (renderer.xr.isPresenting || mobileXRMode) return null;
	const r = renderer.domElement.getBoundingClientRect();
	if (!r.width || !r.height) return null;
	_surfaceNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
	_surfaceRaycaster.setFromCamera(_surfaceNdc, camera);
	return intersectCanvasSurfaces(_surfaceRaycaster);
}
renderer.domElement.addEventListener('pointerdown', (e) => {
	if (e.button !== 0 && e.pointerType === 'mouse') return;
	const hit = desktopSurfaceHit(e);
	if (!hit) return;
	e.stopImmediatePropagation();
	e.preventDefault();
	_desktopSurfaceDrag = { surface: hit.surface, pointerId: e.pointerId };
	try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
	dispatchSurfacePointer(hit.surface, hit.uv, 'move', { pressed: false });
	dispatchSurfacePointer(hit.surface, hit.uv, 'down', { pressed: true });
}, true);
renderer.domElement.addEventListener('pointermove', (e) => {
	if (_desktopSurfaceDrag) {
		if (e.pointerId !== _desktopSurfaceDrag.pointerId) return;
		e.stopImmediatePropagation();
		const hit = desktopSurfaceHit(e);
		if (hit && hit.surface === _desktopSurfaceDrag.surface) dispatchSurfacePointer(hit.surface, hit.uv, 'move', { pressed: true });
		return;
	}
	if (!gsSurfaces.size || e.buttons) return;
	const hit = desktopSurfaceHit(e);
	if (hit) dispatchSurfacePointer(hit.surface, hit.uv, 'move', { pressed: false });
}, true);
const endDesktopSurfaceDrag = (e) => {
	if (!_desktopSurfaceDrag || e.pointerId !== _desktopSurfaceDrag.pointerId) return;
	e.stopImmediatePropagation();
	const drag = _desktopSurfaceDrag;
	_desktopSurfaceDrag = null;
	const hit = desktopSurfaceHit(e);
	const uv = hit && hit.surface === drag.surface ? hit.uv : null;
	if (uv) dispatchSurfacePointer(drag.surface, uv, e.type === 'pointercancel' ? 'cancel' : 'up');
	else dispatchSurfacePointer(drag.surface, { x: 0.5, y: 0.5 }, 'cancel');
};
renderer.domElement.addEventListener('pointerup', endDesktopSurfaceDrag, true);
renderer.domElement.addEventListener('pointercancel', endDesktopSurfaceDrag, true);
// p5Import.js checks this and skips its own pointer bridge (no double events).
window.gsSurfacePointerInput = true;

window.gsCreateP5Surface = gsCreateP5Surface;

// Hooks for p5Import.js: where world content goes (AR placement root in
// Walk-in-AR) and a way to add/remove session code blocks, so an imported
// sketch is saved with the scene and shows up in the code window.
window.gsGetWorldContentParent = getWorldContentParent;
// Blocks run under their session/scene key (like chat blocks) so Code-tab hot
// reload knows them: an unchanged import isn't re-run, and an edited one is
// torn down (iframe + panel) before it runs again.
function rekeyBlockRuntimes(pairs) {
	const moved = [];
	for (const [from, to] of pairs) {
		if (from === to) continue;
		const rt = _blockRuntimes.get(from);
		if (rt) { _blockRuntimes.delete(from); moved.push([to, rt, _blockStates.get(from)]); _blockStates.delete(from); }
	}
	for (const [to, rt, st] of moved) { rt.key = to; _blockRuntimes.set(to, rt); if (st) _blockStates.set(to, st); }
}
window.gsSessionCode = {
	async add(code) {
		await executeVrCode(code, sessionBlockKey(executedCodeBlocks.length));
		executedCodeBlocks.push(code);
		notifyCodeEditorExternalChange();
		renderScenePanel();
	},
	removeWhere(match) {
		let removed = 0;
		const keep = (list, keyOf) => {
			const pairs = [];
			const out = [];
			list.forEach((c, i) => {
				if (match(c)) {
					removed++;
					const rt = _blockRuntimes.get(keyOf(i));
					if (rt) teardownBlock(rt);
				} else {
					pairs.push([keyOf(i), keyOf(out.length)]);
					out.push(c);
				}
			});
			rekeyBlockRuntimes(pairs);
			return out;
		};
		executedCodeBlocks = keep(executedCodeBlocks, sessionBlockKey);
		for (const sc of loadedScenes) {
			if (!sc.active || !Array.isArray(sc.codeBlocks)) continue;
			sc.codeBlocks = keep(sc.codeBlocks, (i) => sceneBlockKey(sc, i));
		}
		if (removed) { notifyCodeEditorExternalChange(); renderScenePanel(); }
		return removed;
	}
};

function buildGsSettingsNote() {
	const lines = ['[GS editor settings: chosen by the user in the editor. Follow them unless this message asks for something else. Do not mention this note.]'];
	const lib = currentSceneLib();
	if (lib === 'three') {
		lines.push('Environment: 3D, THREE.js (default). Build with THREE as usual.');
	} else if (lib === 'webgl') {
		lines.push("Environment: 3D, raw WebGL. Write plain WebGL (your own shaders, buffers and gl.draw* calls) instead of THREE meshes and materials. Get a context with `const surf = gsCreateCanvasSurface({ context: 'webgl2', width: 1024, height: 768 }); const gl = surf.gl;` (it shows the canvas on a panel in the scene and re-uploads it every frame) and draw in a window._vrAnimations callback.");
	} else if (lib === 'p5') {
		lines.push('Environment: 2D, p5.js. Write a p5.js sketch in instance mode and show it with `window.mySketch = await gsCreateP5Surface((p) => { p.setup = () => { p.createCanvas(800, 600); }; p.draw = () => { p.background(20); /* ... */ }; });`. Call every p5 function on `p` (never global mode). The app drives p.draw every frame, also in a headset. Pointer input reaches the sketch on desktop, phone and in a headset (VR controller ray + trigger), so p.mouseX, p.mouseY, p.mouseIsPressed, p.mousePressed and p.mouseDragged work; keyboard input does not, use gsGamepad or window listeners for that.');
	} else if (lib === 'canvas') {
		lines.push('Environment: 2D, blank HTML canvas (no library). Draw with the Canvas 2D API: `const surf = gsCreateCanvasSurface({ width: 1024, height: 768 }); const ctx = surf.ctx;` and animate in a window._vrAnimations callback.');
	}
	if (lib !== 'three') {
		lines.push('Canvas surface options: width, height (pixels), widthMeters (panel width, default 1.6), position [x, y, z] (default [0, 1.4, -2]). The returned object has { canvas, ctx, gl, mesh, texture, dispose() }; keep it on window to reuse it in later blocks.');
	}
	if (GS_DEPS) {
		const deps = GS_DEPS.list.map((d) => `${d.name} ${d.builtIn ? '(always loaded)' : GS_DEPS.isEnabled(d.id) ? '(on)' : '(off)'}`);
		lines.push(`Dependencies on this page: ${deps.join(', ')}. Get a library with \`await gsRequire('ammo' | 'p5' | 'three')\`.`);
		if (GS_DEPS.isEnabled('ammo')) {
			lines.push("Physics: when the scene needs gravity, collisions, rigid bodies, ragdolls, vehicles or other physics, use ammo.js: `const Ammo = await gsRequire('ammo');` (already initialised and cached; never call Ammo() yourself). Create one btDiscreteDynamicsWorld (btDefaultCollisionConfiguration, btCollisionDispatcher, btDbvtBroadphase, btSequentialImpulseConstraintSolver), store it on window (e.g. window.physicsWorld) so later blocks reuse it, step it with world.stepSimulation(dt, 10) in a window._vrAnimations callback, and copy each body's motion-state transform onto its THREE mesh every frame. Free temporary Ammo objects with Ammo.destroy(). Units are metres; the floor is y = 0.");
		} else {
			lines.push('ammo.js is switched off in Dependencies: only use it if the user asks for real physics; simple hand-written motion is fine otherwise.');
		}
	}
	lines.push("Game controllers (Xbox, PlayStation, other USB/Bluetooth pads): `gsGamepad.connected`, `gsGamepad.axis('leftX' | 'leftY' | 'rightX' | 'rightY')` (-1..1, deadzone applied, up is negative), `gsGamepad.button('A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'View' | 'Menu' | 'LS' | 'RS' | 'Up' | 'Down' | 'Left' | 'Right')` (0..1), `gsGamepad.pressed(name)`, `gsGamepad.justPressed(name)` (true for one frame), `gsGamepad.onButton(name, fn)`, `gsGamepad.rumble(ms, strength)`. The sticks move the editor camera by default; set `gsGamepad.captureCamera = true` when the scene uses the sticks itself (a game character, a vehicle). Headset (WebXR) controllers are separate and are not covered by gsGamepad.");
	return lines.join('\n');
}

// Adds the settings note to the newest user message of an outgoing request
// (only the copy that is sent; the stored chat history stays clean).
function withGsSettingsNote(outgoing) {
	let note;
	try { note = buildGsSettingsNote(); } catch (e) { console.error('settings note failed:', e); return outgoing; }
	for (let i = outgoing.length - 1; i >= 0; i--) {
		const m = outgoing[i];
		if (m.role !== 'user') continue;
		const copy = { ...m };
		if (typeof copy.content === 'string') {
			copy.content = `${note}\n\n${copy.content}`;
		} else if (Array.isArray(copy.content)) {
			copy.content = [{ type: 'text', text: note }, ...copy.content];
		}
		const out = outgoing.slice();
		out[i] = copy;
		return out;
	}
	return outgoing;
}

// ============================================================================
// Game controllers (browser Gamepad API): Xbox Series X|S, Xbox One,
// DualSense / DualShock, Switch Pro and other pads, over USB or Bluetooth.
// Separate from WebXR headset controllers, which come through the XR
// session's inputSources (see updateLocomotion).
//   The sticks feed the active stock three.js control (updateGamepadCamera):
//   Orbit / Map: right stick orbits, left stick pans (Orbit: y dollies),
//              LT / RT zoom out / in.
//   First person: left stick walks, right stick looks.
//   Fly:       left stick moves, right stick yaws / pitches, LB / RB down / up.
//   Trackball: sticks unused (no programmatic API).
//   All:       Y switches Orbit <-> First person, View (Back) resets the view.
//   Off:       the controller does not move the camera.
// Browsers only reveal a pad after a button is pressed on it.
// ============================================================================
const GAMEPAD_BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right', 'Home'];
const GAMEPAD_BUTTON_ALIASES = { Back: 'View', Select: 'View', Start: 'Menu', L1: 'LB', R1: 'RB', L2: 'LT', R2: 'RT', L3: 'LS', R3: 'RS', Cross: 'A', Circle: 'B', Square: 'X', Triangle: 'Y', DUp: 'Up', DDown: 'Down', DLeft: 'Left', DRight: 'Right', Guide: 'Home' };
const GAMEPAD_STICK_DEADZONE = THUMBSTICK_DEADZONE;

function gamepadButtonIndex(name) {
	const key = GAMEPAD_BUTTON_ALIASES[name] || name;
	return GAMEPAD_BUTTON_NAMES.indexOf(key);
}

// Radial deadzone, rescaled so movement starts at 0 just past the edge.
function applyStickDeadzone(x, y, dz = GAMEPAD_STICK_DEADZONE) {
	const mag = Math.hypot(x, y);
	if (mag < dz) return [0, 0];
	const scaled = Math.min(1, (mag - dz) / (1 - dz)) / mag;
	return [x * scaled, y * scaled];
}

const gsGamepad = {
	connected: false,
	index: -1,          // navigator.getGamepads() index of the active pad
	id: '',
	mapping: '',
	pads: [],           // every connected pad: { index, id, mapping }
	captureCamera: false,
	deadzone: GAMEPAD_STICK_DEADZONE,
	_axes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
	_buttons: new Array(GAMEPAD_BUTTON_NAMES.length).fill(0),
	_prev: new Array(GAMEPAD_BUTTON_NAMES.length).fill(0),
	_listeners: [],
	axis(name) { return this._axes[name] || 0; },
	button(name) { const i = gamepadButtonIndex(name); return i >= 0 ? this._buttons[i] || 0 : 0; },
	pressed(name) { return this.button(name) > 0.5; },
	justPressed(name) { const i = gamepadButtonIndex(name); return i >= 0 && this._buttons[i] > 0.5 && !(this._prev[i] > 0.5); },
	justReleased(name) { const i = gamepadButtonIndex(name); return i >= 0 && !(this._buttons[i] > 0.5) && this._prev[i] > 0.5; },
	onButton(name, fn) {
		const entry = { name: GAMEPAD_BUTTON_ALIASES[name] || name, fn };
		this._listeners.push(entry);
		return () => { const i = this._listeners.indexOf(entry); if (i >= 0) this._listeners.splice(i, 1); };
	},
	raw() { return this.index >= 0 ? (navigator.getGamepads?.() || [])[this.index] || null : null; },
	rumble(ms = 120, strength = 0.6) {
		const gp = this.raw();
		const act = gp?.vibrationActuator;
		if (!act?.playEffect) return Promise.resolve(false);
		const s = Math.max(0, Math.min(1, strength));
		return act.playEffect('dual-rumble', { duration: ms, strongMagnitude: s, weakMagnitude: s }).then(() => true, () => false);
	},
	_reset() {
		this.captureCamera = false;
		this._listeners = [];
	}
};
window.gsGamepad = gsGamepad;

function gamepadDisplayName(id) {
	const s = String(id || 'Game controller');
	// Chrome: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
	return s.replace(/\s*\((?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/i, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim() || 'Game controller';
}

let _gamepadToastTimer = null;
function showGamepadToast(text) {
	let el = document.getElementById('gs-gamepad-toast');
	if (!el) {
		el = document.createElement('div');
		el.id = 'gs-gamepad-toast';
		el.setAttribute('role', 'status');
		document.body.appendChild(el);
	}
	el.textContent = text;
	el.classList.add('show');
	clearTimeout(_gamepadToastTimer);
	_gamepadToastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function renderGamepadUi() {
	const status = document.getElementById('dchat-gamepad-status');
	if (status) {
		status.textContent = gsGamepad.pads.length
			? gsGamepad.pads.map((p) => `🎮 ${gamepadDisplayName(p.id)}${p.mapping === 'standard' ? '' : ' (non-standard layout)'}`).join(' · ')
			: 'No controller detected. Connect one by USB or Bluetooth, then press any button on it.';
		status.classList.toggle('connected', gsGamepad.pads.length > 0);
	}
	document.body.classList.toggle('gs-gamepad-connected', gsGamepad.connected);
}

function refreshGamepadList() {
	const pads = Array.from(navigator.getGamepads?.() || []).filter((g) => g && g.connected);
	gsGamepad.pads = pads.map((g) => ({ index: g.index, id: g.id, mapping: g.mapping }));
	// Prefer the current pad, then any standard-mapping pad, then anything.
	const active = pads.find((g) => g.index === gsGamepad.index) || pads.find((g) => g.mapping === 'standard') || pads[0];
	gsGamepad.connected = !!active;
	gsGamepad.index = active ? active.index : -1;
	gsGamepad.id = active ? active.id : '';
	gsGamepad.mapping = active ? active.mapping : '';
	if (!active) {
		gsGamepad._buttons.fill(0);
		gsGamepad._prev.fill(0);
		for (const k of Object.keys(gsGamepad._axes)) gsGamepad._axes[k] = 0;
	}
	renderGamepadUi();
}

window.addEventListener('gamepadconnected', (e) => {
	refreshGamepadList();
	showGamepadToast(`🎮 ${gamepadDisplayName(e.gamepad.id)} connected`);
});
window.addEventListener('gamepaddisconnected', (e) => {
	refreshGamepadList();
	showGamepadToast(`🎮 ${gamepadDisplayName(e.gamepad.id)} disconnected`);
});

function pollGamepads() {
	if (!navigator.getGamepads) return;
	if (!gsGamepad.connected) {
		// Some browsers skip gamepadconnected for pads already awake at load.
		if (Array.from(navigator.getGamepads()).some((g) => g && g.connected)) refreshGamepadList();
		if (!gsGamepad.connected) return;
	}
	const gp = gsGamepad.raw();
	if (!gp || !gp.connected) { refreshGamepadList(); return; }
	const prev = gsGamepad._prev;
	const cur = gsGamepad._buttons;
	for (let i = 0; i < cur.length; i++) prev[i] = cur[i];
	for (let i = 0; i < cur.length; i++) {
		const b = gp.buttons[i];
		// Digital buttons report value 1 when pressed; a few pads only set .pressed.
		cur[i] = !b ? 0 : typeof b === 'number' ? b : (b.pressed && !b.value ? 1 : b.value || 0);
	}
	const ax = gp.axes || [];
	const [lx, ly] = applyStickDeadzone(ax[0] || 0, ax[1] || 0, gsGamepad.deadzone);
	const [rx, ry] = applyStickDeadzone(ax[2] || 0, ax[3] || 0, gsGamepad.deadzone);
	gsGamepad._axes.leftX = lx; gsGamepad._axes.leftY = ly;
	gsGamepad._axes.rightX = rx; gsGamepad._axes.rightY = ry;
	for (const { name, fn } of gsGamepad._listeners.slice()) {
		if (gsGamepad.justPressed(name)) {
			try { fn(name); } catch (e) { console.error('gsGamepad.onButton handler error:', e); }
		}
	}
}

// Moves the desktop/phone camera from the pad, matching the Controls tab mode.
// Game controller → the active stock control (see cameraControls.stick):
// Orbit / Map: right stick orbits, left stick pans (Orbit: y dollies in/out),
// LT/RT zoom. First person: left stick walks, right stick looks (through
// PointerLockControls' own mouse-look). Fly: left stick moves, right stick
// yaws/pitches, LB/RB down/up. Trackball: sticks unused. Y switches Orbit /
// First person, View resets the view.
function updateGamepadCamera(dt) {
	if (!gsGamepad.connected || dt <= 0) return null;
	if (cameraControlsSuspended() || gsGamepad.captureCamera) return null;
	if (cameraControls.mode === 'off') return null;
	if (gsGamepad.justPressed('Y')) {
		setCameraControlMode(cameraControls.mode === 'orbit' ? 'firstperson' : 'orbit');
		return null;
	}
	if (gsGamepad.justPressed('View')) { resetCameraView(); return null; }
	return {
		lx: gsGamepad.axis('leftX'), ly: gsGamepad.axis('leftY'),
		rx: gsGamepad.axis('rightX'), ry: gsGamepad.axis('rightY'),
		vertical: gsGamepad.button('RB') - gsGamepad.button('LB'),
		zoom: gsGamepad.button('RT') - gsGamepad.button('LT')
	};
}

// ============================================================================
// On-screen twin joysticks (First person and Fly, desktop and phone; see
// twinSticks.js). Left: move (y forward/back, x sideways). Right: look. Same
// deadzone as the gamepad; the values go to the stock control like the
// gamepad's. Hidden in the other modes, in VR and Cardboard, or when turned
// off in the Controls tab (saved per browser).
// ============================================================================
const TWIN_STICKS_STORAGE_KEY = 'gs.twinSticks';
let twinSticksEnabled = true;
try { twinSticksEnabled = localStorage.getItem(TWIN_STICKS_STORAGE_KEY) !== 'off'; } catch { /* storage blocked */ }
const twinSticks = createTwinSticks({
	layout: () => {
		// Sit just above the bottom dock (the VR / version buttons).
		const dock = document.getElementById('gs-dock');
		// (offsetParent is always null for a position:fixed element, so check display)
		const r = dock && getComputedStyle(dock).display !== 'none' ? dock.getBoundingClientRect() : null;
		return { bottom: r && r.height ? Math.max(0, window.innerHeight - r.top) + 8 : 0 };
	}
});
const dchatTwinSticksToggle = document.getElementById('dchat-twin-sticks');
if (dchatTwinSticksToggle) {
	dchatTwinSticksToggle.checked = twinSticksEnabled;
	dchatTwinSticksToggle.addEventListener('change', () => {
		twinSticksEnabled = dchatTwinSticksToggle.checked;
		try { localStorage.setItem(TWIN_STICKS_STORAGE_KEY, twinSticksEnabled ? 'on' : 'off'); } catch { /* storage blocked */ }
		refreshTwinSticks();
	});
}
function refreshTwinSticks() {
	const want = twinSticksEnabled && STICK_MODES.has(cameraControls.mode) && !cameraControlsSuspended()
		&& !document.body.classList.contains('gs-xr-presenting');
	if (want !== twinSticks.visible) twinSticks.setVisible(want);
}
window.gsRefreshTwinSticks = refreshTwinSticks;
refreshTwinSticks();
window.gsTwinSticks = {
	get visible() { return twinSticks.visible; },
	get enabled() { return twinSticksEnabled; },
	axes: () => twinSticks.axes()
};

// Gamepad and on-screen sticks combined (each past the deadzone), one call
// into the stock control per frame.
const _clampAxis = (v) => Math.max(-1, Math.min(1, v));
function updateStickCamera(dt, pad) {
	refreshTwinSticks();
	const input = pad ? { ...pad } : { lx: 0, ly: 0, rx: 0, ry: 0, vertical: 0, zoom: 0 };
	if (twinSticks.visible) {
		const a = twinSticks.axes();
		const [lx, ly] = applyStickDeadzone(a.lx, a.ly, gsGamepad.deadzone);
		const [rx, ry] = applyStickDeadzone(a.rx, a.ry, gsGamepad.deadzone);
		input.lx = _clampAxis(input.lx + lx); input.ly = _clampAxis(input.ly + ly);
		input.rx = _clampAxis(input.rx + rx); input.ry = _clampAxis(input.ry + ry);
	}
	if (cameraControlsSuspended()) return;
	cameraControls.stick(dt, input);
}

function updateGamepads(dt) {
	pollGamepads();
	updateStickCamera(dt, updateGamepadCamera(dt));
}

refreshGamepadList();

// ============================================================================
// Event Handlers
// ============================================================================
sendButton.addEventListener('click', () => {
	const message = chatInput.value.trim();
	if (message) {
		sendMessage(message);
		chatInput.value = '';
	}
});

chatInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		const message = chatInput.value.trim();
		if (message) {
			sendMessage(message);
			chatInput.value = '';
		}
	}
});

// Collapse-all-UI: wire the DOM toggle button (windowed view).
const uiToggleBtn = document.getElementById('ui-toggle');
if (uiToggleBtn) uiToggleBtn.addEventListener('click', toggleUi);

// Speech-to-text: detect capture support and wire the DOM mic toggle.
initSpeech();
const micButton = document.getElementById('mic-button');
if (micButton) {
	micButton.addEventListener('click', toggleMicAlwaysOn);
	if (!speechSupported) {
		// Only happens with no MediaRecorder/getUserMedia (very old browsers) or a
		// non-secure context that hides mediaDevices entirely.
		micButton.disabled = true;
		micButton.title = 'Microphone capture not available (needs a secure context)';
	} else {
		micButton.title = 'Toggle always-on voice input (in-browser Whisper)';
	}
}

// ============================================================================
// Model selector: populated from whichever backends the server has API keys
// for (GET /api/backends). Selecting an option is sent along with every
// /api/chat and /api/fix-code request as `backend`.
// ============================================================================
async function refreshOllamaModelList() {
	if (!desktopOllamaModelSelect) return;
	desktopOllamaModelSelect.innerHTML = '<option>Checking for local Ollama...</option>';
	desktopOllamaModelSelect.disabled = true;
	try {
		const names = await listOllamaModels();
		desktopOllamaModelSelect.innerHTML = '';
		if (names.length === 0) {
			desktopOllamaModelSelect.innerHTML = '<option>No local models found (try "ollama pull llama3.2")</option>';
			selectedOllamaModel = null;
			return;
		}
		for (const name of names) {
			const opt = document.createElement('option');
			opt.value = name;
			opt.textContent = name;
			desktopOllamaModelSelect.appendChild(opt);
		}
		desktopOllamaModelSelect.disabled = false;
		selectedOllamaModel = names.includes('llama3.2:latest') ? 'llama3.2:latest' : names[0];
		desktopOllamaModelSelect.value = selectedOllamaModel;
	} catch (err) {
		console.error('Failed to reach local Ollama:', err);
		desktopOllamaModelSelect.innerHTML = '<option>Could not reach Ollama - see chat for details</option>';
		selectedOllamaModel = null;
	}
}

function updateOllamaRowVisibility() {
	if (!desktopOllamaModelRow) return;
	desktopOllamaModelRow.style.display = selectedBackend === 'ollama' ? 'flex' : 'none';
}

async function initModelSelect() {
	if (!desktopModelSelect) return;
	try {
		const res = await fetch('/api/prompts');
		cachedPrompts = await res.json();
		ChatPrompt.setDefaults(cachedPrompts);
	} catch (err) {
		console.error('Failed to load /api/prompts (needed for the Ollama backend):', err);
	}

	try {
		const res = await fetch('/api/backends');
		const { backends, default: defaultBackend } = await res.json();

		// "local: true" backends (currently just Ollama) additionally require
		// THIS PAGE to be on localhost - see the Private Network Access note
		// on OLLAMA_UNAVAILABLE_HOSTED_MSG above. That's a client-side fact
		// the server can't know, so it's applied on top of `available` here.
		desktopModelSelect.innerHTML = '';
		backendLabels = {};
		backendProviders = {};
		for (const [id, info] of Object.entries(backends)) {
			backendLabels[id] = info.label || id;
			if (info.provider) backendProviders[id] = info.provider;
			const usable = info.available && (!info.local || IS_LOCAL_PAGE);
			const opt = document.createElement('option');
			opt.value = id;
			opt.textContent = usable
				? info.label
				: !info.available
					? `${info.label} — no API key set`
					: `${info.label} — only when run via python run.py`;
			opt.disabled = !usable;
			desktopModelSelect.appendChild(opt);
		}

		const firstUsable = Object.entries(backends).find(([, info]) => info.available && (!info.local || IS_LOCAL_PAGE))?.[0];
		const defaultUsable = backends[defaultBackend]?.available && (!backends[defaultBackend]?.local || IS_LOCAL_PAGE);
		selectedBackend = defaultUsable ? defaultBackend : (firstUsable || defaultBackend);
		desktopModelSelect.value = selectedBackend;
		updateOllamaRowVisibility();
		if (selectedBackend === 'ollama') refreshOllamaModelList();
	} catch (err) {
		console.error('Failed to load /api/backends:', err);
	}
}

desktopModelSelect?.addEventListener('change', () => {
	selectedBackend = desktopModelSelect.value;
	updateOllamaRowVisibility();
	if (selectedBackend === 'ollama') refreshOllamaModelList();
});

desktopOllamaModelSelect?.addEventListener('change', () => {
	selectedOllamaModel = desktopOllamaModelSelect.value;
});

initModelSelect();

// ============================================================================
// Desktop (non-AR) chat window: movable, resizable, floats over the 3D scene
// ============================================================================
desktopSendButton.addEventListener('click', () => {
	const message = desktopChatInput.value.trim();
	if (message || pendingAttachments.length > 0) {
		sendMessage(message);
		desktopChatInput.value = '';
	}
});

desktopChatInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		const message = desktopChatInput.value.trim();
		if (message || pendingAttachments.length > 0) {
			sendMessage(message);
			desktopChatInput.value = '';
		}
	}
});

desktopAttachButton?.addEventListener('click', () => desktopAttachInput.click());
desktopAttachInput?.addEventListener('change', (e) => {
	addAttachments(e.target.files);
	desktopAttachInput.value = '';
});

desktopFilesPickerButton?.addEventListener('click', () => openFilesPicker('scene'));
themeFilesPickerButton?.addEventListener('click', () => openFilesPicker('theme'));
filesPickerCancel?.addEventListener('click', closeFilesPicker);
filesPickerConfirm?.addEventListener('click', confirmFilesPicker);
filesPickerModal?.addEventListener('click', (e) => {
	if (e.target === filesPickerModal) closeFilesPicker();
});

dchatFilesUpload?.addEventListener('click', () => handleMenuAction('files:upload'));
dchatFilesInput?.addEventListener('change', (e) => {
	addFilesToLibrary(e.target.files);
	dchatFilesInput.value = '';
});
dchatFilesClear?.addEventListener('click', () => handleMenuAction('files:clear'));

if (desktopMicButton) {
	desktopMicButton.addEventListener('click', toggleMicAlwaysOn);
	if (!speechSupported) {
		desktopMicButton.disabled = true;
		desktopMicButton.title = 'Microphone capture not available (needs a secure context)';
	} else {
		desktopMicButton.title = 'Toggle always-on voice input (in-browser Whisper)';
	}
}

if (desktopChatMinimizeBtn) {
	// Minimize = Hide UI; bring the panel back with Show UI only.
	desktopChatMinimizeBtn.addEventListener('click', () => setUiCollapsed(true));
}
if (desktopChatExpandBtn) {
	desktopChatExpandBtn.addEventListener('click', () => toggleDesktopChatExpanded());
}

const CHAT_SIZE_KEY = 'carljr-chat-window';
let _chatSizeBeforeExpand = null;

function setDesktopChatMinimized(minimized) {
	desktopChat.classList.toggle('hidden', minimized);
	if (!minimized) fitDesktopChatToViewport();
}

function saveDesktopChatSize() {
	if (desktopChat.classList.contains('expanded')) return;
	// Off-screen while mirrored into VR; don't persist the parked rect.
	if (desktopChat.classList.contains('html-in-canvas-source')) return;
	try {
		const rect = desktopChat.getBoundingClientRect();
		localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify({
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height
		}));
	} catch { /* ignore */ }
}

function isNarrowDesktopChat() {
	// Phones in landscape are wider than 720px but get the same "stay inside
	// the visible area" handling (_phoneLayout is set further down).
	return window.matchMedia('(max-width: 720px)').matches || !!_phoneLayout;
}

let _safeAreaProbe = null;
let _fitChatRaf = 0;

function readSafeAreaInsets() {
	if (!_safeAreaProbe) {
		_safeAreaProbe = document.createElement('div');
		_safeAreaProbe.setAttribute('aria-hidden', 'true');
		_safeAreaProbe.style.cssText = [
			'position:fixed',
			'top:0',
			'left:0',
			'visibility:hidden',
			'pointer-events:none',
			'padding-top:constant(safe-area-inset-top)',
			'padding-top:env(safe-area-inset-top,0px)',
			'padding-right:constant(safe-area-inset-right)',
			'padding-right:env(safe-area-inset-right,0px)',
			'padding-bottom:constant(safe-area-inset-bottom)',
			'padding-bottom:env(safe-area-inset-bottom,0px)',
			'padding-left:constant(safe-area-inset-left)',
			'padding-left:env(safe-area-inset-left,0px)'
		].join(';');
		document.documentElement.appendChild(_safeAreaProbe);
	}
	const cs = getComputedStyle(_safeAreaProbe);
	return {
		top: parseFloat(cs.paddingTop) || 0,
		right: parseFloat(cs.paddingRight) || 0,
		bottom: parseFloat(cs.paddingBottom) || 0,
		left: parseFloat(cs.paddingLeft) || 0
	};
}

// Visible rectangle in getBoundingClientRect coordinates. visualViewport
// excludes the URL bar and other browser chrome; safe-area insets cover the
// status bar and home indicator drawn on top of that viewport.
function desktopChatVisibleBox() {
	const vv = window.visualViewport;
	const safe = readSafeAreaInsets();
	const margin = 8;
	const width = vv && vv.width > 0 ? vv.width : window.innerWidth;
	const height = vv && vv.height > 0 ? vv.height : window.innerHeight;
	return {
		left: safe.left + margin,
		top: safe.top + margin,
		right: width - safe.right - margin,
		bottom: height - safe.bottom - margin
	};
}

// position:fixed top/left stay on the layout viewport in iOS Safari, while
// getBoundingClientRect is visual. The difference is visualViewport.offsetTop
// while chrome shows, and it changes when the URL bar hides. Measuring it
// from the panel avoids adding that offset a second time on browsers where
// fixed already tracks the visual viewport.
function desktopChatFixedShift() {
	const vv = window.visualViewport;
	const fallback = {
		top: vv ? vv.offsetTop : 0,
		left: vv ? vv.offsetLeft : 0
	};
	if (!desktopChat || !desktopChat.getClientRects().length) return fallback;
	const cs = getComputedStyle(desktopChat);
	const rect = desktopChat.getBoundingClientRect();
	const top = parseFloat(cs.top);
	const left = parseFloat(cs.left);
	if (!Number.isFinite(top) || !Number.isFinite(left)) return fallback;
	return { top: top - rect.top, left: left - rect.left };
}

function clampRectToBox(rect, box, minW = 0, minH = 0) {
	const maxW = Math.max(0, box.right - box.left);
	const maxH = Math.max(0, box.bottom - box.top);
	const width = Math.min(Math.max(rect.width, Math.min(minW, maxW)), maxW);
	const height = Math.min(Math.max(rect.height, Math.min(minH, maxH)), maxH);
	let left = rect.left;
	let top = rect.top;
	if (left + width > box.right) left = box.right - width;
	if (top + height > box.bottom) top = box.bottom - height;
	if (left < box.left) left = box.left;
	if (top < box.top) top = box.top;
	return { left, top, width, height };
}

function syncDesktopChatViewportVars(box, shift) {
	const root = document.documentElement.style;
	const names = ['--dchat-vv-top', '--dchat-vv-left', '--dchat-vv-width', '--dchat-vv-height'];
	if (!box) {
		for (const name of names) root.removeProperty(name);
		return;
	}
	const next = {
		'--dchat-vv-top': `${Math.round(box.top + shift.top)}px`,
		'--dchat-vv-left': `${Math.round(box.left + shift.left)}px`,
		'--dchat-vv-width': `${Math.round(Math.max(0, box.right - box.left))}px`,
		'--dchat-vv-height': `${Math.round(Math.max(0, box.bottom - box.top))}px`
	};
	for (const name of names) {
		if (root.getPropertyValue(name) !== next[name]) root.setProperty(name, next[name]);
	}
}

function restoreDesktopChatSize() {
	try {
		const raw = localStorage.getItem(CHAT_SIZE_KEY);
		if (!raw) return;
		const s = JSON.parse(raw);
		if (!s || !s.width || !s.height) return;
		const narrow = isNarrowDesktopChat();
		let w = s.width;
		let h = s.height;
		let left = s.left ?? 24;
		let top = s.top ?? 80;
		if (narrow) {
			// Saved left/top are visual coordinates. Do not trust them on their
			// own: clamp into the current visual viewport, then convert to the
			// fixed-position coordinate system.
			const box = desktopChatVisibleBox();
			if (box.right - box.left >= 32 && box.bottom - box.top >= 32) {
				const clamped = clampRectToBox({ left, top, width: w, height: h }, box, 280, 220);
				const shift = desktopChatFixedShift();
				w = clamped.width;
				h = clamped.height;
				left = clamped.left + shift.left;
				top = clamped.top + shift.top;
			}
		} else {
			const margin = 0;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const maxW = Math.max(280, vw - 16);
			const maxH = Math.max(220, vh - 16);
			const minW = Math.min(280, maxW);
			const minH = Math.min(220, maxH);
			w = Math.max(minW, Math.min(maxW, s.width));
			h = Math.max(minH, Math.min(maxH, s.height));
			left = Math.max(margin, Math.min(vw - w - margin, s.left ?? 24));
			top = Math.max(margin, Math.min(vh - h - margin, s.top ?? 80));
		}
		desktopChat.style.width = `${w}px`;
		desktopChat.style.height = `${h}px`;
		desktopChat.style.left = `${left}px`;
		desktopChat.style.top = `${top}px`;
		if (narrow) desktopChat.style.right = 'auto';
	} catch { /* ignore */ }
}

// Phones only. Always pulls the header (minimize / expand) fully inside the
// visual viewport — a saved top, or a top that was correct for the layout
// viewport, is not enough when Safari's URL bar or status bar covers it.
// Re-run on visualViewport resize and scroll so showing or hiding chrome
// moves the panel with the visible area instead of leaving the header above it.
function fitDesktopChatToViewport() {
	if (!desktopChat) return;
	if (!isNarrowDesktopChat()) {
		syncDesktopChatViewportVars(null, null);
		return;
	}
	if (desktopChat.classList.contains('dragging') || desktopChat.classList.contains('resizing')) return;
	// Keyboard up: CSS (html.gs-kb-chat) sizes the panel to the visible area;
	// don't shrink its saved size, so it comes back when the keyboard closes.
	if (_kbChat) return;
	const box = desktopChatVisibleBox();
	if (box.right - box.left < 32 || box.bottom - box.top < 32) return;
	const shift = desktopChatFixedShift();
	syncDesktopChatViewportVars(box, shift);
	if (!desktopChat.getClientRects().length) return;
	if (desktopChat.classList.contains('expanded')) return;

	const rect = desktopChat.getBoundingClientRect();
	const next = clampRectToBox(rect, box);
	if (next.width < 1 || next.height < 1) return;
	const eps = 0.5;
	if (
		Math.abs(next.left - rect.left) < eps &&
		Math.abs(next.top - rect.top) < eps &&
		Math.abs(next.width - rect.width) < eps &&
		Math.abs(next.height - rect.height) < eps
	) return;

	desktopChat.style.width = `${Math.round(next.width)}px`;
	desktopChat.style.height = `${Math.round(next.height)}px`;
	desktopChat.style.left = `${Math.round(next.left + shift.left)}px`;
	desktopChat.style.top = `${Math.round(next.top + shift.top)}px`;
	desktopChat.style.right = 'auto';
}

function scheduleFitDesktopChat() {
	if (_fitChatRaf) return;
	_fitChatRaf = requestAnimationFrame(() => {
		_fitChatRaf = 0;
		fitDesktopChatToViewport();
	});
}

function toggleDesktopChatExpanded() {
	const expanding = !desktopChat.classList.contains('expanded');
	if (expanding) {
		const rect = desktopChat.getBoundingClientRect();
		_chatSizeBeforeExpand = {
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height
		};
		desktopChat.classList.add('expanded');
		if (desktopChatExpandBtn) {
			desktopChatExpandBtn.title = 'Restore window';
			desktopChatExpandBtn.innerHTML = '&#x2750;';
		}
	} else {
		desktopChat.classList.remove('expanded');
		const s = _chatSizeBeforeExpand;
		if (s) {
			desktopChat.style.width = `${s.width}px`;
			desktopChat.style.height = `${s.height}px`;
			desktopChat.style.left = `${s.left}px`;
			desktopChat.style.top = `${s.top}px`;
			desktopChat.style.right = 'auto';
		}
		_chatSizeBeforeExpand = null;
		if (desktopChatExpandBtn) {
			desktopChatExpandBtn.title = 'Expand window';
			desktopChatExpandBtn.innerHTML = '&#x26F6;';
		}
	}
	// Sync while both states are in the DOM so expanded fills the visual
	// viewport and a restored window cannot sit under the status bar.
	fitDesktopChatToViewport();
	if (!expanding) saveDesktopChatSize();
}

restoreDesktopChatSize();
fitDesktopChatToViewport();
window.addEventListener('resize', scheduleFitDesktopChat);
window.addEventListener('orientationchange', () => {
	scheduleFitDesktopChat();
	// iOS reports the new visual viewport a beat after orientationchange.
	setTimeout(scheduleFitDesktopChat, 350);
});
if (window.visualViewport) {
	window.visualViewport.addEventListener('resize', scheduleFitDesktopChat);
	window.visualViewport.addEventListener('scroll', scheduleFitDesktopChat);
}
window.addEventListener('pageshow', scheduleFitDesktopChat);
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') scheduleFitDesktopChat();
});

// ============================================================================
// Phone layout + on-screen keyboard (phones only; desktop, tablets and VR
// never get these classes, see index.html "Phones").
// ============================================================================
// html.gs-phone   a touch screen whose short side is <= 600px.
// html.gs-kb      a text field has focus and the on-screen keyboard is (or is
//                 about to be) up. Hides the dock, Hide UI, joysticks.
// html.gs-kb-chat the field is inside the GS panel: the panel fills the
//                 visible area above the keyboard (--gs-kb-*) with only the
//                 messages / editor and the input row, like a messaging app.
// The keyboard is detected from the visual viewport: Android Chrome with
// interactive-widget=resizes-content shrinks the window, iOS Safari only
// shrinks visualViewport. Both shrink visualViewport.height.
const _coarsePointer = window.matchMedia('(pointer: coarse)');
const KB_MIN_SHRINK = 120;    // px of lost height that means "keyboard up"
const KB_SETTLE_MS = 900;     // keyboard animation; after this a focused field with no shrink = no keyboard
var _phoneLayout = false;
var _kbOpen = false;
var _kbChat = false; // var: read by functions that run before this point
var _kbFocusAt = 0;
var _kbTimer = 0;
var _vvBase = { width: 0, height: 0 };

function computePhoneLayout() {
	if (!_coarsePointer.matches) return false;
	const sw = window.screen ? Math.min(window.screen.width || 0, window.screen.height || 0) : 0;
	const short = sw > 0 ? sw : Math.min(window.innerWidth, window.innerHeight);
	return short <= 600;
}
function isPhoneLayout() { return _phoneLayout; }

// The SVG menu buttons (Scenes, Export, Themes) are laid out at a fixed width
// and scaled to the panel, so on a phone a 44px row renders ~40px. Taller rows
// keep them at least 44px on screen. Desktop keeps the base height.
function phoneMenuButtonHeight(base, layoutWidth) {
	if (!computePhoneLayout()) return base;
	const short = window.screen ? Math.min(window.screen.width || 0, window.screen.height || 0) : 0;
	const panelInner = Math.max(240, (short || Math.min(window.innerWidth, window.innerHeight)) - 44);
	return Math.ceil(46 * layoutWidth / Math.min(layoutWidth, panelInner));
}

function visualViewportSize() {
	const vv = window.visualViewport;
	return {
		width: vv && vv.width > 0 ? vv.width : window.innerWidth,
		height: vv && vv.height > 0 ? vv.height : window.innerHeight,
		top: vv ? vv.offsetTop : 0,
		left: vv ? vv.offsetLeft : 0
	};
}

// Tallest visible height seen at this width = the height without a keyboard.
function updateViewportBase(v) {
	const w = Math.round(v.width);
	if (Math.abs(w - _vvBase.width) > 2) _vvBase = { width: w, height: 0 };
	const h = Math.max(v.height, _kbOpen ? 0 : window.innerHeight);
	if (h > _vvBase.height) _vvBase.height = h;
}

function keyboardTextField() {
	const el = document.activeElement;
	if (!el || !isTextEntry(el) || el.tagName === 'SELECT') return null;
	if (el.disabled || el.readOnly) return null;
	return el;
}

function syncKeyboardViewportVars(v) {
	const root = document.documentElement.style;
	if (!_kbOpen) {
		for (const n of ['--gs-kb-top', '--gs-kb-left', '--gs-kb-width', '--gs-kb-height']) root.removeProperty(n);
		return;
	}
	const safe = readSafeAreaInsets();
	const m = 4;
	// Same fixed-position correction the panel uses (iOS keeps position:fixed
	// on the layout viewport while visualViewport scrolls).
	const shift = desktopChatFixedShift();
	const top = v.top + safe.top + m;
	const left = v.left + safe.left + m;
	root.setProperty('--gs-kb-top', `${Math.round(top + (shift.top - v.top))}px`);
	root.setProperty('--gs-kb-left', `${Math.round(left + (shift.left - v.left))}px`);
	root.setProperty('--gs-kb-width', `${Math.round(Math.max(0, v.width - safe.left - safe.right - 2 * m))}px`);
	// The keyboard covers the home indicator, so no bottom safe area here.
	root.setProperty('--gs-kb-height', `${Math.round(Math.max(0, v.height - safe.top - 2 * m))}px`);
}

function chatMessagesNearBottom(el) {
	return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}
function pinKeyboardView(force) {
	// Latest messages stay in view, and the focused field is fully visible.
	for (const id of ['desktop-chat-messages', 'dchat-theme-chat-messages']) {
		const list = document.getElementById(id);
		if (list && list.offsetParent && (force || list.dataset.gsPinned === '1')) list.scrollTop = list.scrollHeight;
	}
	const f = keyboardTextField();
	if (f && !f.closest('#desktop-chat')) f.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	else if (f && f.tagName === 'TEXTAREA' && f.id === 'dchat-code-editor') {
		// Keep the caret line inside the shrunken editor.
		const lh = parseFloat(getComputedStyle(f).lineHeight) || 20;
		const line = f.value.slice(0, f.selectionStart || 0).split('\n').length;
		const caretY = line * lh;
		if (caretY > f.scrollTop + f.clientHeight - lh) f.scrollTop = caretY - f.clientHeight + lh;
	}
}

function updateKeyboardState(reason = '') {
	const v = visualViewportSize();
	const phone = computePhoneLayout();
	if (phone !== _phoneLayout) {
		_phoneLayout = phone;
		document.documentElement.classList.toggle('gs-phone', phone);
		scheduleFitDesktopChat();
		twinSticks.place(); // the phone dock is taller
	}
	updateViewportBase(v);
	const field = phone && !document.body.classList.contains('gs-xr-presenting') && !document.body.classList.contains('gs-cardboard-active') ? keyboardTextField() : null;
	const shrink = _vvBase.height - v.height;
	let open = false;
	if (field) {
		if (shrink >= KB_MIN_SHRINK) open = true;
		else if (reason === 'focus' || reason === 'tap') { open = true; _kbFocusAt = performance.now(); }
		else open = _kbOpen && performance.now() - _kbFocusAt < KB_SETTLE_MS;
	}
	const chat = open && !!field.closest('#desktop-chat');
	const changed = open !== _kbOpen || chat !== _kbChat;
	if (changed && open) {
		for (const id of ['desktop-chat-messages', 'dchat-theme-chat-messages']) {
			const list = document.getElementById(id);
			if (list) list.dataset.gsPinned = '1';
		}
	}
	_kbOpen = open;
	_kbChat = chat;
	document.documentElement.classList.toggle('gs-kb', open);
	document.documentElement.classList.toggle('gs-kb-chat', chat);
	syncKeyboardViewportVars(v);
	if (open) pinKeyboardView(changed);
	if (changed) {
		scheduleFitDesktopChat();
		if (!open) scheduleRendererResize();
	}
	clearTimeout(_kbTimer);
	if (open && shrink < KB_MIN_SHRINK) _kbTimer = setTimeout(() => updateKeyboardState('settle'), KB_SETTLE_MS + 50);
}

function isKeyboardLayoutActive() { return _kbChat; }

document.addEventListener('focusin', () => updateKeyboardState('focus'));
document.addEventListener('focusout', () => setTimeout(() => updateKeyboardState('blur'), 150));
// Tapping a field that kept focus after the keyboard was dismissed reopens it.
document.addEventListener('pointerdown', (e) => {
	if (_phoneLayout && e.target === document.activeElement && keyboardTextField()) setTimeout(() => updateKeyboardState('tap'), 0);
}, true);
// Remember whether each chat list is scrolled to the bottom, so the keyboard
// opening or closing keeps the newest messages in view.
for (const id of ['desktop-chat-messages', 'dchat-theme-chat-messages']) {
	const list = document.getElementById(id);
	if (!list) continue;
	list.addEventListener('scroll', () => { list.dataset.gsPinned = chatMessagesNearBottom(list) ? '1' : '0'; }, { passive: true });
	new MutationObserver(() => { if (list.dataset.gsPinned !== '0') list.scrollTop = list.scrollHeight; }).observe(list, { childList: true, subtree: true });
}
// Send / More / tools: keep the field focused (keyboard stays up) on phones,
// like a messaging app. mousedown's default action is what moves focus.
for (const id of ['desktop-send-button', 'desktop-chat-more', 'dchat-theme-chat-send']) {
	const btn = document.getElementById(id);
	if (btn) btn.addEventListener('mousedown', (e) => { if (_phoneLayout && keyboardTextField()) e.preventDefault(); });
}
const _onViewportChange = () => updateKeyboardState('viewport');
window.addEventListener('resize', _onViewportChange);
window.addEventListener('orientationchange', () => setTimeout(_onViewportChange, 350));
if (window.visualViewport) {
	window.visualViewport.addEventListener('resize', _onViewportChange);
	window.visualViewport.addEventListener('scroll', _onViewportChange);
}
_coarsePointer.addEventListener?.('change', _onViewportChange);
updateKeyboardState('init');

// "More" (+) in the chat input row on phones: attach / files / mic / history.
(function initChatMoreButton() {
	const compose = document.getElementById('desktop-chat-compose-row');
	const row = document.getElementById('desktop-chat-input-row');
	if (!compose || !row || document.getElementById('desktop-chat-more')) return;
	const more = document.createElement('button');
	more.type = 'button';
	more.id = 'desktop-chat-more';
	more.title = 'More: attach, files, voice, history';
	more.setAttribute('aria-label', 'More actions');
	more.setAttribute('aria-expanded', 'false');
	more.setAttribute('aria-controls', 'desktop-chat-tools-row');
	more.textContent = '+';
	more.addEventListener('click', () => {
		const open = !row.classList.contains('gs-tools-open');
		row.classList.toggle('gs-tools-open', open);
		more.setAttribute('aria-expanded', String(open));
		more.textContent = open ? '×' : '+';
	});
	compose.insertBefore(more, compose.firstChild);
})();

// Phone tab row scrolls sideways: keep the active tab in view and drop the
// right-edge fade at the end of the row.
(function initPhoneTabRow() {
	const tabs = document.getElementById('desktop-chat-tabs');
	if (!tabs) return;
	const edge = () => tabs.classList.toggle('gs-at-end', tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 4);
	tabs.addEventListener('scroll', edge, { passive: true });
	tabs.addEventListener('click', (e) => {
		const t = e.target.closest('.dchat-tab');
		if (t && _phoneLayout) t.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
	});
	window.addEventListener('resize', edge);
	edge();
})();

// Dragging via the header. Uses document-level mouse listeners (rather than
// pointer capture) so it keeps tracking even if the cursor briefly leaves the
// header while moving fast.
(function initDesktopChatDrag() {
	let dragging = false;
	let startX = 0, startY = 0, startLeft = 0, startTop = 0;
	let shiftLeft = 0, shiftTop = 0;
	let phoneBox = null;

	desktopChatHeader.addEventListener('mousedown', (e) => {
		if (e.target.closest('#desktop-chat-header-buttons')) return;
		dragging = true;
		desktopChat.classList.add('dragging');
		const rect = desktopChat.getBoundingClientRect();
		startX = e.clientX;
		startY = e.clientY;
		startLeft = rect.left;
		startTop = rect.top;
		if (isNarrowDesktopChat()) {
			const shift = desktopChatFixedShift();
			shiftLeft = shift.left;
			shiftTop = shift.top;
			phoneBox = desktopChatVisibleBox();
		} else {
			shiftLeft = 0;
			shiftTop = 0;
			phoneBox = null;
		}
		e.preventDefault();
	});

	document.addEventListener('mousemove', (e) => {
		if (!dragging) return;
		const rect = desktopChat.getBoundingClientRect();
		let newLeft = startLeft + (e.clientX - startX);
		let newTop = startTop + (e.clientY - startY);
		if (phoneBox) {
			newLeft = Math.max(phoneBox.left, Math.min(phoneBox.right - rect.width, newLeft));
			newTop = Math.max(phoneBox.top, Math.min(phoneBox.bottom - rect.height, newTop));
			desktopChat.style.left = `${newLeft + shiftLeft}px`;
			desktopChat.style.top = `${newTop + shiftTop}px`;
		} else {
			newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
			newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));
			desktopChat.style.left = `${newLeft}px`;
			desktopChat.style.top = `${newTop}px`;
		}
	});

	document.addEventListener('mouseup', () => {
		if (!dragging) return;
		dragging = false;
		desktopChat.classList.remove('dragging');
		fitDesktopChatToViewport();
	});
})();

// Resizing via any edge or corner (hold and drag). Each handle carries a
// data-dir of which sides move: n/s/e/w or a combination for corners.
(function initDesktopChatResize() {
	const MIN_W = 280, MIN_H = 220;
	let resizing = false;
	let dir = '';
	let startX = 0, startY = 0, startWidth = 0, startHeight = 0, startLeft = 0, startTop = 0;
	let activePointerId = null;

	function onPointerDown(e) {
		if (desktopChat.classList.contains('expanded')) return;
		resizing = true;
		dir = e.currentTarget.dataset.dir;
		activePointerId = e.pointerId;
		desktopChat.classList.add('resizing');
		const rect = desktopChat.getBoundingClientRect();
		startX = e.clientX;
		startY = e.clientY;
		startWidth = rect.width;
		startHeight = rect.height;
		startLeft = rect.left;
		startTop = rect.top;
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
		e.preventDefault();
	}

	function onPointerMove(e) {
		if (!resizing) return;
		if (activePointerId != null && e.pointerId !== activePointerId) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		const phone = isNarrowDesktopChat();
		const box = phone ? desktopChatVisibleBox() : null;
		const minW = phone ? Math.min(MIN_W, Math.max(120, box.right - box.left)) : MIN_W;
		const minH = phone ? Math.min(MIN_H, Math.max(120, box.bottom - box.top)) : MIN_H;
		const shift = phone ? desktopChatFixedShift() : null;

		if (dir.includes('e')) {
			const limit = phone ? box.right - startLeft : window.innerWidth - startLeft - 8;
			const newWidth = Math.max(minW, Math.min(limit, startWidth + dx));
			desktopChat.style.width = `${newWidth}px`;
		}
		if (dir.includes('s')) {
			const limit = phone ? box.bottom - startTop : window.innerHeight - startTop - 8;
			const newHeight = Math.max(minH, Math.min(limit, startHeight + dy));
			desktopChat.style.height = `${newHeight}px`;
		}
		if (dir.includes('w')) {
			const maxDx = startWidth - minW;
			const minDx = phone ? box.left - startLeft : -startLeft;
			const clampedDx = Math.max(minDx, Math.min(maxDx, dx));
			desktopChat.style.width = `${startWidth - clampedDx}px`;
			const left = startLeft + clampedDx;
			desktopChat.style.left = `${phone ? left + shift.left : left}px`;
		}
		if (dir.includes('n')) {
			const maxDy = startHeight - minH;
			const minDy = phone ? box.top - startTop : -startTop;
			const clampedDy = Math.max(minDy, Math.min(maxDy, dy));
			desktopChat.style.height = `${startHeight - clampedDy}px`;
			const top = startTop + clampedDy;
			desktopChat.style.top = `${phone ? top + shift.top : top}px`;
		}
	}

	function onPointerUp(e) {
		if (!resizing) return;
		if (activePointerId != null && e.pointerId !== activePointerId) return;
		resizing = false;
		dir = '';
		activePointerId = null;
		desktopChat.classList.remove('resizing');
		fitDesktopChatToViewport();
		saveDesktopChatSize();
	}

	document.querySelectorAll('.dchat-resize').forEach(handle => {
		handle.addEventListener('pointerdown', onPointerDown);
		handle.addEventListener('pointermove', onPointerMove);
		handle.addEventListener('pointerup', onPointerUp);
		handle.addEventListener('pointercancel', onPointerUp);
	});
})();

// Ctrl+Arrow snaps the chat window to the nearest screen edge (or corner
// with a diagonal-feeling combo: press twice, once per axis). Only active
// when not immersive and not typing in a text field.
document.addEventListener('keydown', (e) => {
	if (!e.ctrlKey) return;
	const arrowDirs = { ArrowLeft: 'w', ArrowRight: 'e', ArrowUp: 'n', ArrowDown: 's' };
	const dir = arrowDirs[e.key];
	if (!dir) return;
	if (desktopChat.classList.contains('hidden')) return;
	if (renderer.xr.isPresenting) return;
	const activeTag = document.activeElement && document.activeElement.tagName;
	if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

	e.preventDefault();
	const rect = desktopChat.getBoundingClientRect();
	const margin = 8;
	const phone = isNarrowDesktopChat();
	const box = phone ? desktopChatVisibleBox() : null;
	const shift = phone ? desktopChatFixedShift() : null;
	let left = rect.left, top = rect.top;
	if (dir === 'w') left = phone ? box.left : margin;
	if (dir === 'e') left = phone ? box.right - rect.width : window.innerWidth - rect.width - margin;
	if (dir === 'n') top = phone ? box.top : margin;
	if (dir === 's') top = phone ? box.bottom - rect.height : window.innerHeight - rect.height - margin;
	desktopChat.style.left = `${phone ? left + shift.left : left}px`;
	desktopChat.style.top = `${phone ? top + shift.top : top}px`;
	if (phone) fitDesktopChatToViewport();
});

// Tabs: Chat (Scene|Theme) / Environment / Scenes / Files / Code / Community (Scenes|Themes) / Controls / Dependencies / Share.
document.querySelectorAll('.dchat-tab').forEach(tab => {
	tab.addEventListener('click', () => {
		document.querySelectorAll('.dchat-tab').forEach(t => t.classList.remove('active'));
		document.querySelectorAll('.dchat-panel').forEach(p => p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById(`dchat-panel-${tab.dataset.tab}`).classList.add('active');
		if (tab.dataset.tab === 'community') setCommunitySection(communitySection);
		if (tab.dataset.tab === 'code') syncCodeEditorFromState({ force: false });
	});
});

// Code tab: edit generated VR program with optional live re-apply.
if (dchatCodeEditor) {
	dchatCodeEditor.addEventListener('input', markCodeEditorDirty);
	dchatCodeEditor.addEventListener('keydown', (e) => {
		// Keep Tab inserting spaces inside the editor instead of leaving the field.
		if (e.key === 'Tab') {
			e.preventDefault();
			const start = dchatCodeEditor.selectionStart;
			const end = dchatCodeEditor.selectionEnd;
			const v = dchatCodeEditor.value;
			dchatCodeEditor.value = v.slice(0, start) + '	' + v.slice(end);
			dchatCodeEditor.selectionStart = dchatCodeEditor.selectionEnd = start + 1;
			codeHighlightApi?.refresh();
			markCodeEditorDirty();
		}
	});
}
if (dchatCodeApply) dchatCodeApply.addEventListener('click', () => hotReloadFromEditor());
const dchatCodeReset = document.getElementById('dchat-code-reset');
if (dchatCodeReset) dchatCodeReset.addEventListener('click', () => applyCodeFromEditor());
if (dchatCodeRevert) dchatCodeRevert.addEventListener('click', revertCodeEditor);
if (dchatCodeLive) {
	dchatCodeLive.checked = false; // default OFF for safety
	dchatCodeLive.addEventListener('change', () => {
		if (dchatCodeLive.checked && codeEditorDirty) scheduleLiveCodeApply();
	});
}
syncCodeEditorFromState({ force: true });

document.querySelectorAll('#dchat-community-subtabs .dchat-subtab').forEach(btn => {
	btn.addEventListener('click', () => setCommunitySection(btn.dataset.communitySection));
});
document.querySelectorAll('#dchat-chat-subtabs .dchat-subtab').forEach(btn => {
	btn.addEventListener('click', () => setChatSection(btn.dataset.chatSection));
});
// Chat → Prompt editor (chatPrompt.js). Redraw the headset panel on changes.
window.GSChatPrompt = ChatPrompt; // console / test access
ChatPrompt.initPromptEditor({
	onOpenPrompt: () => setChatSection('prompt'),
	onStatus: (t) => updateStatus(t, 'connected')
});
ChatPrompt.onChange(() => { if (chatSection === 'prompt') renderChatToCanvas(); });
// Console / test access to the headset chat panel (Chat → Prompt in VR).
window.gsChatPanel = {
	get section() { return chatSection; },
	get canvas() { return chatCanvas; },
	action: (a) => handleMenuAction(a),
	xrSend: (text) => { inputText = String(text ?? ''); handleXRSend(); }
};

syncRememberThemeCheckboxes();
if (dchatThemeRemember) {
	dchatThemeRemember.addEventListener('change', () => setRememberTheme(dchatThemeRemember.checked));
}
if (dchatThemeRememberCommunity) {
	dchatThemeRememberCommunity.addEventListener('change', () => setRememberTheme(dchatThemeRememberCommunity.checked));
}
if (dchatThemeChatSend) dchatThemeChatSend.addEventListener('click', sendThemeChat);
if (dchatThemeChatInput) {
	dchatThemeChatInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); sendThemeChat(); }
	});
}


// ============================================================================
// 360 / HDRI environment (Environment tab)
// ============================================================================
function setHdriStatus(text, kind) {
	if (!dchatHdriStatus) return;
	dchatHdriStatus.textContent = text || '';
	dchatHdriStatus.style.color = kind === 'error' ? '#f87171'
		: kind === 'ok' ? '#34d399'
		: 'rgba(255,255,255,0.4)';
}

function getPmremGenerator() {
	if (!pmremGenerator) {
		pmremGenerator = new THREE.PMREMGenerator(renderer);
		pmremGenerator.compileEquirectangularShader();
	}
	return pmremGenerator;
}

function disposeHdriTextures({ revokeBlob = true } = {}) {
	if (scene.environment === hdriPMREM) scene.environment = null;
	if (scene.background === hdriEquirect) scene.background = null;
	if (hdriPMREM) { hdriPMREM.dispose(); hdriPMREM = null; }
	if (hdriEquirect) { hdriEquirect.dispose(); hdriEquirect = null; }
	if (revokeBlob && hdriObjectUrl) {
		URL.revokeObjectURL(hdriObjectUrl);
		hdriObjectUrl = null;
	}
}

function clearHdriEnvironment() {
	disposeHdriTextures({ revokeBlob: true });
	hdriPersistUrl = null;
	try { localStorage.removeItem(HDRI_URL_STORAGE_KEY); } catch { /* ignore */ }
	applyEnvironmentMode();
	setHdriStatus('Cleared', '');
}

async function loadHdriTextureFromUrl(url) {
	const lower = String(url).split('?')[0].toLowerCase();
	if (lower.endsWith('.hdr') || lower.endsWith('.hdri')) {
		return new HDRLoader().loadAsync(url);
	}
	if (lower.endsWith('.exr')) {
		return new EXRLoader().loadAsync(url);
	}
	return new THREE.TextureLoader().loadAsync(url);
}

async function applyHdriFromUrl(url, { persist = false, objectUrl = null } = {}) {
	if (!url) return;
	setHdriStatus('Loading…', 'pending');
	try {
		const tex = await loadHdriTextureFromUrl(url);
		tex.mapping = THREE.EquirectangularReflectionMapping;
		const isHdr = /\.(hdr|hdri|exr)($|\?)/i.test(url);
		tex.colorSpace = isHdr ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
		tex.needsUpdate = true;

		const envRT = getPmremGenerator().fromEquirectangular(tex);
		disposeHdriTextures({ revokeBlob: !objectUrl });
		if (objectUrl) hdriObjectUrl = objectUrl;

		hdriEquirect = tex;
		hdriPMREM = envRT.texture;
		scene.environment = hdriPMREM;
		hdriUseAsBackground = !!(dchatHdriBg ? dchatHdriBg.checked : true);
		applyEnvironmentMode();

		if (persist && /^https?:\/\//i.test(url)) {
			hdriPersistUrl = url;
			try { localStorage.setItem(HDRI_URL_STORAGE_KEY, url); } catch { /* ignore */ }
		} else if (objectUrl) {
			hdriPersistUrl = null;
		} else {
			hdriPersistUrl = /^https?:\/\//i.test(url) ? url : null;
		}
		setHdriStatus(hdriPersistUrl ? 'Loaded (URL kept for reload)' : 'Loaded (local file — not persisted)', 'ok');
	} catch (err) {
		console.error('HDRI load failed:', err);
		setHdriStatus('Error: ' + (err && err.message ? err.message : err), 'error');
	}
}


// ============================================================================
// GS version badge + picker (bottom of screen)
// ============================================================================
function initGsVersionPicker() {
	const btn = document.getElementById('gs-version-btn');
	const modal = document.getElementById('gs-version-modal');
	const listEl = document.getElementById('gs-version-list');
	const closeBtn = document.getElementById('gs-version-close');
	if (!btn || !modal || !listEl) return;

	btn.innerHTML = '';
	const prefix = document.createElement('span');
	prefix.className = 'gs-dock-prefix';
	prefix.textContent = 'GS ';
	btn.append(prefix, `v${GS_VERSION}`);
	btn.setAttribute('aria-label', `GS version ${GS_VERSION}. Choose version.`);

	let versions = mergeVersionList(null);
	let loading = false;

	function hide() {
		modal.classList.remove('visible');
		modal.setAttribute('aria-hidden', 'true');
	}

	function show() {
		modal.classList.add('visible');
		modal.setAttribute('aria-hidden', 'false');
		// Open at the top so the newest changelog entry is what you see first.
		closeBtn?.focus({ preventScroll: true });
		const inner = document.getElementById('gs-version-modal-inner');
		if (inner) inner.scrollTop = 0;
	}

	function renderList() {
		listEl.innerHTML = '';
		for (const entry of versions) {
			// One card per version: the open/switch row, then its changelog.
			const item = document.createElement('div');
			item.className = 'gs-version-item';
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'gs-version-row';
			const current = isCurrentVersionEntry(entry);
			if (current) row.classList.add('current');
			const label = document.createElement('span');
			label.textContent = entry.label || `GS ${entry.id}`;
			const meta = document.createElement('span');
			meta.className = 'gs-version-meta';
			meta.textContent = [entry.date, current ? 'Current' : (entry.url ? 'Open' : entry.id)].filter(Boolean).join(' · ');
			row.appendChild(label);
			row.appendChild(meta);
			item.appendChild(row);
			if (entry.changes?.length) {
				const ul = document.createElement('ul');
				ul.className = 'gs-version-changes';
				for (const change of entry.changes) {
					const li = document.createElement('li');
					li.textContent = change;
					ul.appendChild(li);
				}
				item.appendChild(ul);
			}
			row.addEventListener('click', () => {
				if (current || entry.url == null || entry.url === '') {
					hide();
					return;
				}
				try {
					const target = new URL(entry.url, location.href);
					if (target.href === location.href) {
						hide();
						return;
					}
					location.assign(target.href);
				} catch (err) {
					console.warn('[gs] bad version url', entry, err);
					updateStatus(`Invalid version URL for ${entry.id}`, 'error');
				}
			});
			listEl.appendChild(item);
		}
	}

	async function refreshVersions() {
		if (loading) return;
		loading = true;
		try {
			const manifest = await loadVersionManifest();
			versions = mergeVersionList(manifest);
		} catch (err) {
			console.warn('[gs] versions.json load failed', err);
			versions = mergeVersionList(null);
		} finally {
			loading = false;
			renderList();
		}
	}

	btn.addEventListener('click', () => {
		show();
		refreshVersions();
		renderList();
	});
	closeBtn?.addEventListener('click', hide);
	modal.addEventListener('click', (e) => {
		if (e.target === modal) hide();
	});
	window.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && modal.classList.contains('visible')) hide();
	});

	renderList();
	refreshVersions();
}

function initHdriControls() {
	if (dchatHdriBg) {
		hdriUseAsBackground = dchatHdriBg.checked;
		dchatHdriBg.addEventListener('change', () => {
			hdriUseAsBackground = dchatHdriBg.checked;
			applyEnvironmentMode();
		});
	}
	if (dchatHdriPick && dchatHdriFile) {
		dchatHdriPick.addEventListener('click', () => dchatHdriFile.click());
		dchatHdriFile.addEventListener('change', async () => {
			const file = dchatHdriFile.files && dchatHdriFile.files[0];
			dchatHdriFile.value = '';
			if (!file) return;
			const obj = URL.createObjectURL(file);
			await applyHdriFromUrl(obj, { persist: false, objectUrl: obj });
		});
	}
	if (dchatHdriUrlLoad && dchatHdriUrl) {
		dchatHdriUrlLoad.addEventListener('click', () => {
			const u = (dchatHdriUrl.value || '').trim();
			if (!u) { setHdriStatus('Enter a URL', 'error'); return; }
			applyHdriFromUrl(u, { persist: true });
		});
		dchatHdriUrl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				dchatHdriUrlLoad.click();
			}
		});
	}
	if (dchatHdriClear) dchatHdriClear.addEventListener('click', clearHdriEnvironment);

	try {
		const saved = localStorage.getItem(HDRI_URL_STORAGE_KEY);
		if (saved && /^https?:\/\//i.test(saved)) {
			if (dchatHdriUrl) dchatHdriUrl.value = saved;
			applyHdriFromUrl(saved, { persist: true });
		}
	} catch { /* ignore */ }
}

initHdriControls();
initGsVersionPicker();

if (dchatCodeEditor && dchatCodeHighlight) {
	codeHighlightApi = mountCodeHighlight(dchatCodeEditor, dchatCodeHighlight);
}

// Environment tab: VR mode (shared button spec, see ENV_MODE_BUTTONS/
// handleMenuAction), color picker, brightness slider. The toggle buttons
// themselves are (re)mounted by renderDomEnv() since their active/inactive
// styling depends on isVRMode.
dchatColorPicker.addEventListener('input', () => {
	const hex = dchatColorPicker.value;
	const c = new THREE.Color(hex);
	const hsl = { h: 0, s: 0, l: 0 };
	c.getHSL(hsl);
	vrBgHue = hsl.h * 360;
	vrBgSat = hsl.s;
	vrBgLight = hsl.l;
	applyEnvironmentMode();
	renderSidePanel();
});
dchatBrightness.addEventListener('input', () => {
	vrBgLight = Math.max(0.02, Math.min(0.95, Number(dchatBrightness.value) / 100));
	applyEnvironmentMode();
	renderSidePanel();
});
dchatResetCameraBtn.addEventListener('click', resetCameraView);

// Scenes / Community tabs: shared button specs (SCENES_BUTTONS,
// EXPORT_COMBINED_BUTTON, COMMUNITY_BUTTONS) mounted once - their content
// never changes, only EXPORT_COMBINED_BUTTON's visibility does (toggled in
// renderDomSceneList via the .visible class on its mount div).
mountButtonsToDOM(dchatScenesButtonsMount, SCENES_BUTTONS_DOM, { width: 384, height: phoneMenuButtonHeight(44, 384), gap: 8, minWidth: 100, fontSize: 12 }, handleMenuAction);
mountButtonsToDOM(dchatExportCombinedMount, EXPORT_COMBINED_BUTTON, { width: 384, height: phoneMenuButtonHeight(44, 384), gap: 8, perRow: 1, fontSize: 13 }, handleMenuAction);
renderCommunityDesktopButtons();
renderCommunityLoadModeControls();
if (dchatThemesButtonsMount) {
	mountButtonsToDOM(dchatThemesButtonsMount, THEME_BUTTONS, { width: 384, height: phoneMenuButtonHeight(44, 384), gap: 8, perRow: 3, fontSize: 11 }, handleMenuAction);
}

// Switches between the desktop chat window (windowed browser) and the slim
// dom-overlay bar (VR immersive session), and shows/hides the legacy 3D
// canvas panels accordingly — the desktop window replaces them entirely.
function xrSessionActive() {
	return !!(renderer && renderer.xr && renderer.xr.isPresenting);
}

// One place for XR panel visibility so the HTML-in-canvas toggle and Hide UI
// cannot disagree. Desktop (not presenting) is unchanged: canvas panels stay
// hidden and #desktop-chat stays the on-screen menu.
function applyXrPanelVisibility(immersive = xrSessionActive()) {
	const show = immersive && !uiCollapsed && !displayOnlyMode;
	const html = show && htmlInCanvas;
	if (chatPanel) chatPanel.visible = show && !html;
	if (inputPanel) inputPanel.visible = show && !html;
	if (scenePanel) scenePanel.visible = show && !html;
	// Side panel is the VR menu that hosts the HTML-in-canvas toggle.
	if (sidePanel) sidePanel.visible = show;
	if (keyboardPanel) {
		const kb = show && !keyboardCollapsed && (!html || htmlKeyboardForDom);
		keyboardPanel.visible = kb;
	}
	if (htmlInCanvasPanel) htmlInCanvasPanel.visible = html;

	if (desktopChat) {
		desktopChat.classList.toggle('html-in-canvas-source', html);
		const hideDom = displayOnlyMode || (immersive ? !html : uiCollapsed);
		desktopChat.classList.toggle('hidden', hideDom);
	}
	if (chatOverlayBar) {
		chatOverlayBar.style.display = '';
		// Slim dom-overlay bar is the fallback text field. Hide it while the
		// full desktop element is mirrored in-world so it doesn't cover the view.
		chatOverlayBar.classList.toggle('visible', immersive && !displayOnlyMode && !uiCollapsed && !html);
	}
}

function setImmersiveUiMode(immersive) {
	// The head-locked hud (Hide/Show-UI panel) only makes sense with a headset;
	// the desktop equivalent is the #ui-toggle button. The status badge is not shown.
	hud.visible = immersive && !displayOnlyMode;
	// Mouse orbit/pan/zoom only makes sense windowed — the headset pose drives
	// the camera during an XR session.
	refreshCameraControls();
	if (immersive) cameraControls.unlock();
	document.body.classList.toggle('gs-xr-presenting', !!immersive);
	applyXrPanelVisibility(immersive);
}

// ============================================================================
// Window Resize
// ============================================================================
var _rendererSize = { w: window.innerWidth, h: window.innerHeight };
var _rendererResizeTimer = 0;
function applyRendererSize() {
	_rendererResizeTimer = 0;
	const w = window.innerWidth, h = window.innerHeight;
	// While the phone keyboard is up (Android shrinks the window), keep the
	// canvas at its full size: it sits behind the panel, and resizing it on
	// every keyboard animation frame just thrashes WebGL.
	if (isKeyboardLayoutActive() && w === _rendererSize.w) return;
	if (w === _rendererSize.w && h === _rendererSize.h && renderer.domElement.width) {
		const px = renderer.getPixelRatio();
		if (Math.round(w * px) === renderer.domElement.width && Math.round(h * px) === renderer.domElement.height) return;
	}
	_rendererSize = { w, h };
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	renderer.setSize(w, h);
}
function scheduleRendererResize() {
	clearTimeout(_rendererResizeTimer);
	_rendererResizeTimer = setTimeout(applyRendererSize, 150);
}
function onWindowResize() {
	// Phones: debounce (keyboard and URL-bar animations fire many resizes).
	// Desktop, tablets and VR / Cardboard resize immediately as before.
	if (isPhoneLayout() && !renderer.xr.isPresenting && !document.body.classList.contains('gs-cardboard-active')) {
		scheduleRendererResize();
		return;
	}
	applyRendererSize();
}

window.addEventListener('resize', onWindowResize);

// ============================================================================
// VR Session Handlers
// ============================================================================
function positionAllPanels(chatY) {
	const inputY = chatY - CHAT_PANEL_HEIGHT / 2 - INPUT_PANEL_GAP - INPUT_PANEL_HEIGHT / 2;
	const kbY = inputY - INPUT_PANEL_HEIGHT / 2 - KEYBOARD_PANEL_GAP - KEYBOARD_PANEL_HEIGHT / 2;
	const sideX = CHAT_PANEL_WIDTH / 2 + SIDE_PANEL_GAP + SIDE_PANEL_WIDTH / 2;
	const sceneX = -(CHAT_PANEL_WIDTH / 2 + SCENE_PANEL_GAP + SCENE_PANEL_WIDTH / 2);
	if (chatPanel) chatPanel.position.set(0, chatY, -CHAT_PANEL_DISTANCE);
	if (inputPanel) inputPanel.position.set(0, inputY, -CHAT_PANEL_DISTANCE);
	if (keyboardPanel) keyboardPanel.position.set(0, kbY, -CHAT_PANEL_DISTANCE);
	if (sidePanel) sidePanel.position.set(sideX, chatY, -CHAT_PANEL_DISTANCE);
	if (scenePanel) scenePanel.position.set(sceneX, chatY, -CHAT_PANEL_DISTANCE);
	if (htmlInCanvas) layoutHtmlInCanvasPanel(chatY);
}

renderer.xr.addEventListener('sessionstart', () => {
	// 'local-floor' reference space: origin at the real floor, eye level
	// is around y=1.6, so anchor panels just below eye level for comfort.
	positionAllPanels(1.4);
	resetPanelAnchor();
	if (windowAnchorMode === 'follow') _anchorSnapNext = true; // start right in front of you
	setImmersiveUiMode(true);
	applyLayDownView();

	// Always VR color/skybox. immersive-ar is not started.
	isVRMode = true;
	applyEnvironmentMode();
	renderSidePanel();
	renderDomEnv();
});

renderer.xr.addEventListener('sessionend', () => {
	positionAllPanels(1.4);
	resetPanelAnchor();
	isVRMode = true;
	applyEnvironmentMode();
	applyLayDownView(); // clear pitch so desktop orbit stays upright
	renderSidePanel();
	renderDomEnv();
	setImmersiveUiMode(false);
	resetCameraView(); // back to the default desktop view (not the headset pose)
});

// ============================================================================
// Window anchoring — Fixed (in the world) or Follow head (lazy, yaw-only)
// ============================================================================
// Every XR window (chat, input, keyboard, side, scene/code, HTML mirror) is a
// child of panelAnchor, positioned exactly as before in its local space. In
// Fixed mode the anchor is the identity, so nothing changes. In Follow mode
// the anchor glides to the head's position and heading, but only once the
// windows drift out of a comfort zone (turned away > 50 degrees, walked > 0.4 m
// or head height changed > 0.3 m), then eases in and stops. Yaw only, so the
// windows stay upright. Per frame it is a handful of vector ops and no
// allocations; raycasts use the updated matrices, so buttons keep working
// while the windows move.
const WINDOW_ANCHOR_STORAGE_KEY = 'gs.windowAnchor';
const WINDOW_ANCHOR_MODES = ['fixed', 'follow'];
const FOLLOW_EYE_HEIGHT = 1.6;               // panel layout assumes eyes at 1.6 m (panels at 1.4 m)
const FOLLOW_YAW_START = THREE.MathUtils.degToRad(50);
const FOLLOW_YAW_STOP = THREE.MathUtils.degToRad(1);
const FOLLOW_DIST_START = 0.4;
const FOLLOW_HEIGHT_START = 0.3;
const FOLLOW_STOP_DIST = 0.02;
const FOLLOW_RATE = 4;                       // 1/s exponential ease
let windowAnchorMode = 'fixed';
let _anchorFollowing = false;
let _anchorSnapNext = false;
let _anchorYaw = 0;
const panelAnchor = new THREE.Group();
panelAnchor.name = 'gsPanelAnchor';
scene.add(panelAnchor);
const _anchorHeadPos = new THREE.Vector3();
const _anchorHeadDir = new THREE.Vector3();

function resetPanelAnchor() {
	panelAnchor.position.set(0, 0, 0);
	panelAnchor.rotation.set(0, 0, 0);
	_anchorYaw = 0;
	_anchorFollowing = false;
	panelAnchor.updateMatrixWorld(true);
}

function wrapAngle(a) {
	while (a > Math.PI) a -= Math.PI * 2;
	while (a < -Math.PI) a += Math.PI * 2;
	return a;
}

// Called once per XR frame before the panel billboarding and raycasts.
function updatePanelAnchor(dt, xrCamera) {
	if (windowAnchorMode !== 'follow') return;
	// Don't slide a window out from under an active trigger drag.
	if (htmlScrollDrag[0] || htmlScrollDrag[1]) return;
	xrCamera.getWorldPosition(_anchorHeadPos);
	xrCamera.getWorldDirection(_anchorHeadDir);
	const horiz = Math.hypot(_anchorHeadDir.x, _anchorHeadDir.z);
	// Looking straight up/down: heading is undefined, keep the current one.
	const headYaw = horiz > 0.2 ? Math.atan2(-_anchorHeadDir.x, -_anchorHeadDir.z) : _anchorYaw;
	const tx = _anchorHeadPos.x;
	const ty = _anchorHeadPos.y - FOLLOW_EYE_HEIGHT;
	const tz = _anchorHeadPos.z;
	const p = panelAnchor.position;
	const dYaw = wrapAngle(headYaw - _anchorYaw);
	const dist = Math.hypot(tx - p.x, tz - p.z);
	const dy = ty - p.y;
	if (_anchorSnapNext) {
		_anchorSnapNext = false;
		p.set(tx, ty, tz);
		_anchorYaw = headYaw;
		_anchorFollowing = false;
	} else {
		if (!_anchorFollowing && (Math.abs(dYaw) > FOLLOW_YAW_START || dist > FOLLOW_DIST_START || Math.abs(dy) > FOLLOW_HEIGHT_START)) {
			_anchorFollowing = true;
		}
		if (!_anchorFollowing) return;
		const k = 1 - Math.exp(-FOLLOW_RATE * Math.max(dt, 1 / 120));
		p.x += (tx - p.x) * k;
		p.y += dy * k;
		p.z += (tz - p.z) * k;
		_anchorYaw = wrapAngle(_anchorYaw + dYaw * k);
		if (Math.abs(dYaw) < FOLLOW_YAW_STOP && dist < FOLLOW_STOP_DIST && Math.abs(dy) < FOLLOW_STOP_DIST) {
			_anchorFollowing = false;
		}
	}
	panelAnchor.rotation.set(0, _anchorYaw, 0);
	panelAnchor.updateMatrixWorld(true);
}

function renderWindowAnchorUi() {
	document.querySelectorAll('#dchat-window-anchor [data-window-anchor]').forEach((btn) => {
		const on = btn.dataset.windowAnchor === windowAnchorMode;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', on ? 'true' : 'false');
	});
}

function setWindowAnchorMode(mode, { persist = true } = {}) {
	if (!WINDOW_ANCHOR_MODES.includes(mode)) mode = 'fixed';
	windowAnchorMode = mode;
	if (mode === 'fixed') {
		resetPanelAnchor();
	} else if (xrSessionActive()) {
		// Glide in from wherever the windows are now.
		_anchorFollowing = true;
	}
	if (persist) {
		try { localStorage.setItem(WINDOW_ANCHOR_STORAGE_KEY, mode); } catch { /* storage blocked */ }
	}
	renderWindowAnchorUi();
	renderSidePanel();
	updateStatus(mode === 'follow' ? 'Windows follow your head' : 'Windows fixed in place', '');
}

document.querySelectorAll('#dchat-window-anchor [data-window-anchor]').forEach((btn) => {
	btn.addEventListener('click', () => setWindowAnchorMode(btn.dataset.windowAnchor));
});

// ============================================================================
// HTML in canvas — live #desktop-chat mirrored onto a VR menu mesh
// ============================================================================
function createHtmlInCanvasPanel() {
	htmlInCanvasCanvas = document.createElement('canvas');
	htmlInCanvasCanvas.width = 4;
	htmlInCanvasCanvas.height = 4;
	htmlInCanvasTexture = new THREE.CanvasTexture(htmlInCanvasCanvas);
	htmlInCanvasTexture.minFilter = THREE.LinearFilter;
	htmlInCanvasTexture.magFilter = THREE.LinearFilter;
	const geometry = new THREE.PlaneGeometry(CHAT_PANEL_WIDTH, CHAT_PANEL_HEIGHT);
	const material = new THREE.MeshBasicMaterial({
		map: htmlInCanvasTexture,
		transparent: true,
		side: THREE.DoubleSide
	});
	htmlInCanvasPanel = new THREE.Mesh(geometry, material);
	htmlInCanvasPanel.name = 'htmlInCanvasPanel';
	htmlInCanvasPanel.visible = false;
	htmlInCanvasPanel.position.set(0, 1.4, -CHAT_PANEL_DISTANCE);
	scene.add(htmlInCanvasPanel);
}

function layoutHtmlInCanvasPanel(chatY = 1.4) {
	if (!htmlInCanvasPanel) return;
	const aspect = htmlInCanvasAspect > 0.05 ? htmlInCanvasAspect : 1.35;
	let width = 1.15;
	let height = width * aspect;
	const maxH = 1.25;
	if (height > maxH) {
		height = maxH;
		width = height / aspect;
	}
	const params = htmlInCanvasPanel.geometry && htmlInCanvasPanel.geometry.parameters;
	if (!params || Math.abs(params.width - width) > 0.001 || Math.abs(params.height - height) > 0.001) {
		htmlInCanvasPanel.geometry.dispose();
		htmlInCanvasPanel.geometry = new THREE.PlaneGeometry(width, height);
	}
	htmlInCanvasPanel.position.set(0, chatY, -CHAT_PANEL_DISTANCE);
	// Keep the Environment side panel (the toggle) just to the right of the mirror.
	if (htmlInCanvas && sidePanel) {
		const sideX = width / 2 + SIDE_PANEL_GAP + SIDE_PANEL_WIDTH / 2;
		sidePanel.position.set(sideX, chatY, -CHAT_PANEL_DISTANCE);
	}
	if (htmlInCanvas && keyboardPanel && keyboardPanel.visible) {
		const kbY = chatY - height / 2 - KEYBOARD_PANEL_GAP - KEYBOARD_PANEL_HEIGHT / 2;
		keyboardPanel.position.set(0, kbY, -CHAT_PANEL_DISTANCE);
	}
}

// The mirror is repainted only when #desktop-chat actually changed (DOM
// mutation, scroll, input, focus) instead of unconditionally every 200 ms.
// Each repaint walks the menu and re-uploads the texture, which on a Quest
// was the frame-time hog while the Code tab was open.
const HTML_PAINT_MIN_MS = 66;      // cap repaints at ~15/s while content changes
const HTML_PAINT_IDLE_MS = 2000;   // safety refresh for CSS-only changes (hover, animations)
let _htmlDirty = true;
let _htmlObserver = null;
function markHtmlInCanvasDirty() { _htmlDirty = true; }
function watchHtmlInCanvasSource(on) {
	if (!desktopChat) return;
	if (on && !_htmlObserver) {
		_htmlObserver = new MutationObserver(markHtmlInCanvasDirty);
		_htmlObserver.observe(desktopChat, { subtree: true, childList: true, characterData: true, attributes: true });
		for (const ev of ['scroll', 'input', 'change', 'focusin', 'focusout']) {
			desktopChat.addEventListener(ev, markHtmlInCanvasDirty, true);
		}
	} else if (!on && _htmlObserver) {
		_htmlObserver.disconnect();
		_htmlObserver = null;
		for (const ev of ['scroll', 'input', 'change', 'focusin', 'focusout']) {
			desktopChat.removeEventListener(ev, markHtmlInCanvasDirty, true);
		}
	}
	_htmlDirty = true;
}

function tickHtmlInCanvas(force) {
	if (!htmlInCanvasPanel || !htmlInCanvasPanel.visible || !desktopChat || !htmlInCanvasCanvas) return;
	const now = performance.now();
	if (!force) {
		const since = now - _htmlPaintAt;
		if (_htmlDirty ? since < HTML_PAINT_MIN_MS : since < HTML_PAINT_IDLE_MS) return;
	}
	_htmlPaintAt = now;
	_htmlDirty = false;
	try {
		const metrics = paintElementToCanvas(desktopChat, htmlInCanvasCanvas);
		if (htmlInCanvasTexture) htmlInCanvasTexture.needsUpdate = true;
		if (metrics && metrics.width > 0) {
			const aspect = metrics.height / metrics.width;
			if (Math.abs(aspect - htmlInCanvasAspect) > 0.02) {
				htmlInCanvasAspect = aspect;
				layoutHtmlInCanvasPanel();
			}
		}
	} catch (err) {
		console.warn('HTML in canvas paint failed:', err);
	}
}

function setHtmlInCanvas(on) {
	htmlInCanvas = !!on;
	watchHtmlInCanvasSource(htmlInCanvas);
	if (!htmlInCanvas) htmlKeyboardForDom = false;
	applyXrPanelVisibility(xrSessionActive());
	if (htmlInCanvas) {
		htmlInCanvasAspect = 0;
		tickHtmlInCanvas(true);
		layoutHtmlInCanvasPanel();
	} else {
		positionAllPanels(1.4);
	}
	renderSidePanel();
	updateStatus(htmlInCanvas ? 'HTML in canvas: showing desktop menu' : 'XR canvas panels', '');
}

function htmlInCanvasTextField() {
	if (!htmlInCanvas || !htmlKeyboardForDom || !desktopChat) return null;
	const el = document.activeElement;
	if (!isHtmlTextField(el) || !desktopChat.contains(el)) return null;
	return el;
}

function dispatchKeyToDomField(el, key) {
	const write = (text) => {
		const start = el.selectionStart == null ? el.value.length : el.selectionStart;
		const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
		el.value = el.value.slice(0, start) + text + el.value.slice(end);
		const pos = start + text.length;
		try { el.setSelectionRange(pos, pos); } catch { /* type=number etc. */ }
		el.dispatchEvent(new Event('input', { bubbles: true }));
	};
	switch (key.action) {
		case 'char': {
			let c = key.value;
			if (keyboardShift && /^[a-z]$/.test(c)) c = c.toUpperCase();
			write(c);
			if (keyboardShift) {
				keyboardShift = false;
				renderKeyboardToCanvas();
			}
			break;
		}
		case 'space':
			write(' ');
			break;
		case 'backspace': {
			const start = el.selectionStart == null ? el.value.length : el.selectionStart;
			const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
			if (start === end && start > 0) {
				el.value = el.value.slice(0, start - 1) + el.value.slice(end);
				try { el.setSelectionRange(start - 1, start - 1); } catch { /* ignore */ }
			} else {
				el.value = el.value.slice(0, start) + el.value.slice(end);
				try { el.setSelectionRange(start, start); } catch { /* ignore */ }
			}
			el.dispatchEvent(new Event('input', { bubbles: true }));
			break;
		}
		case 'shift':
			keyboardShift = !keyboardShift;
			renderKeyboardToCanvas();
			break;
		case 'symbols':
			keyboardSymbols = !keyboardSymbols;
			keyboardShift = false;
			renderKeyboardToCanvas();
			break;
		case 'enter':
			if (el instanceof HTMLTextAreaElement) write('\n');
			else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			break;
	}
}

// ============================================================================
// Initialize and Animation Loop
// ============================================================================
createChatPanel();
createInputPanel();
createKeyboardPanel();
createSidePanel();
createScenePanel();
createHtmlInCanvasPanel();
// All XR windows ride on panelAnchor (identity in Fixed mode, see above).
for (const panel of [chatPanel, inputPanel, keyboardPanel, sidePanel, scenePanel, htmlInCanvasPanel]) {
	if (panel) panelAnchor.add(panel);
}
{
	let savedAnchor = null;
	try { savedAnchor = localStorage.getItem(WINDOW_ANCHOR_STORAGE_KEY); } catch { /* storage blocked */ }
	windowAnchorMode = savedAnchor === 'follow' ? 'follow' : 'fixed';
	renderWindowAnchorUi();
}
createHudStatus();
createUiToggle();
// Start in windowed (non-XR) mode: the desktop chat window is the UI, and the
// legacy 3D canvas panels stay hidden until a VR session starts.
setImmersiveUiMode(false);
applyEnvironmentMode();

// Populate the community list (and auto-load /s/:id or /e/:id / ?scene= shares).
// Runs after setImmersiveUiMode so display-only can hide the desktop chrome cleanly.
// Theme restore is opt-in (Remember theme). Default: start from DEFAULT_THEME
// and do not keep a previously saved theme around.
if (rememberTheme) {
	const cachedTheme = loadCachedTheme();
	if (cachedTheme) applyTheme(cachedTheme);
	else currentTheme = { ...DEFAULT_THEME, cssVars: { ...DEFAULT_THEME.cssVars } };
} else {
	currentTheme = { ...DEFAULT_THEME, cssVars: { ...DEFAULT_THEME.cssVars } };
	try { localStorage.removeItem(THEME_CACHE_KEY); } catch { /* ignore */ }
}

loadContextLibrary();

bootSharedScene();

// Snapshot system objects so we can distinguish user-created objects later
snapshotSystemObjects();

// Add welcome message
const welcomeMsg = 'VR Code Assistant ready. Ask me to add objects, modify the scene, or inject HTML — I\'ll write and execute the code live.';
displayMessages.push({ role: 'assistant', content: welcomeMsg });
renderChatToCanvas();

const _rayTempMatrix = new THREE.Matrix4();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _hitRaycaster = new THREE.Raycaster();
const _hitTargets = []; // populated after panels exist

// World-anchored XR panels plus the head-locked hud (status + Hide/Show UI).
// Reticles register themselves in createReticle. Anything added under these
// roots later is pulled onto layer 1 by applyMenuLayerPriority() each frame.
registerMenuRoot(chatPanel);
registerMenuRoot(inputPanel);
registerMenuRoot(keyboardPanel);
registerMenuRoot(sidePanel);
registerMenuRoot(scenePanel);
registerMenuRoot(htmlInCanvasPanel);
registerMenuRoot(hud);
applyMenuLayerPriority();
// Previous per-hand button-pressed state, for edge detection (ray toggle) and
// hold detection (push-to-talk). Keyed by handedness → button index → bool.
const _prevButtons = { left: {}, right: {} };
let _stickScrollAt = 0;
const _cameraWorldPos = new THREE.Vector3();

renderer.setAnimationLoop((time) => {
	// Frame delta (seconds), clamped so a paused/backgrounded tab doesn't jump.
	const dt = _locoPrevTime ? Math.min(0.1, (time - _locoPrevTime) / 1000) : 0;
	_locoPrevTime = time;

	// Voice-activity detection for always-on mic. Driven here (not via
	// window.requestAnimationFrame, which is paused during immersive sessions) so
	// transcription segmentation works in MR as well as the windowed view.
	pumpVad();


	// Billboard effect: panels face the camera while staying upright
	if (renderer.xr.isPresenting) {
		const xrCamera = renderer.xr.getCamera();
		const cameraWorldPos = _cameraWorldPos;
		xrCamera.getWorldPosition(cameraWorldPos);
		updatePanelAnchor(dt, xrCamera);

		if (chatPanel) chatPanel.lookAt(cameraWorldPos);
		if (inputPanel) inputPanel.lookAt(cameraWorldPos);
		if (keyboardPanel) keyboardPanel.lookAt(cameraWorldPos);
		if (sidePanel) sidePanel.lookAt(cameraWorldPos);
		if (scenePanel) scenePanel.lookAt(cameraWorldPos);
		if (htmlInCanvasPanel && htmlInCanvasPanel.visible) htmlInCanvasPanel.lookAt(cameraWorldPos);
		tickHtmlInCanvas(false);

		// Build hit-target list (panels that exist and are showing)
		_hitTargets.length = 0;
		if (uiTogglePanel && !displayOnlyMode) _hitTargets.push(uiTogglePanel); // always reachable (unless display-only share)
		if (!uiCollapsed && !displayOnlyMode) {
			if (htmlInCanvasPanel && htmlInCanvasPanel.visible) _hitTargets.push(htmlInCanvasPanel);
			if (scenePanel && scenePanel.visible) _hitTargets.push(scenePanel);
			if (sidePanel && sidePanel.visible) _hitTargets.push(sidePanel);
			if (inputPanel && inputPanel.visible) _hitTargets.push(inputPanel);
			if (keyboardPanel && keyboardPanel.visible) _hitTargets.push(keyboardPanel);
			if (chatPanel && chatPanel.visible) _hitTargets.push(chatPanel);
		}

		// Update reticles per controller; track keyboard hover across both hands.
		let frameKbHover = -1;
		for (let i = 0; i < 2; i++) {
			const controller = renderer.xr.getController(i);
			const reticle = reticles[i];
			if (!controller || !reticle) continue;

			_rayTempMatrix.identity().extractRotation(controller.matrixWorld);
			_rayOrigin.setFromMatrixPosition(controller.matrixWorld);
			_rayDir.set(0, 0, -1).applyMatrix4(_rayTempMatrix);

			_hitRaycaster.set(_rayOrigin, _rayDir);
			const intersects = _hitRaycaster.intersectObjects(_hitTargets);

			// Canvas surfaces (p5 / blank canvas) — hover, cursor dot, events.
			const surfHit = updateSurfacePointer(i, _rayOrigin, _rayDir, intersects, reticle);
			if (surfHit) {
				// cursor dot already placed on the sketch
			} else if (intersects.length > 0) {
				const hit = intersects[0];
				reticle.position.copy(hit.point);
				// Face along hit normal (toward the camera side of the panel)
				reticle.lookAt(
					hit.point.x + hit.face.normal.x,
					hit.point.y + hit.face.normal.y,
					hit.point.z + hit.face.normal.z
				);
				reticle.visible = true;

				// Highlight color based on what's being aimed at
				if (hit.object === uiTogglePanel) {
					reticle.material.color.setHex(0x8b5cf6); // purple — UI toggle
				} else if (hit.object === scenePanel) {
					reticle.material.color.setHex(0xf59e0b); // amber for scene panel
				} else if (hit.object === sidePanel) {
					reticle.material.color.setHex(0x10b981); // green for side panel
				} else if (hit.object === keyboardPanel) {
					reticle.material.color.setHex(0x6366f1); // indigo
					if (hit.uv) frameKbHover = keyIndexAtUV(hit.uv);
				} else if (hit.object === htmlInCanvasPanel) {
					reticle.material.color.setHex(0x6366f1);
				} else if (hit.object === inputPanel && hit.uv) {
					const L = inputPanelLayout();
					const cx = hit.uv.x * L.W;
					if (cx >= L.sendX) reticle.material.color.setHex(0x8b5cf6); // purple — send
					else if (cx >= L.micX) reticle.material.color.setHex(0x22d3ee); // cyan — mic/keys buttons
					else reticle.material.color.setHex(0x6366f1); // indigo
				} else {
					reticle.material.color.setHex(0x6366f1); // indigo
				}
			} else {
				reticle.visible = false;
			}
			if (htmlScrollDrag[i]) {
				const htmlHit = intersects.find((h) => h.object === htmlInCanvasPanel && h.uv);
				if (htmlHit) moveHtmlInCanvasScrollDrag(i, htmlHit.uv);
			}
		}
		// Apply keyboard hover (re-renders only when the hovered key changes)
		setKeyboardHover(keyboardCollapsed ? -1 : frameKbHover);
		// Poll thumbsticks (scrolling) and buttons (ray toggle + push-to-talk)
		const session = renderer.xr.getSession();
		if (session) {
			for (const source of session.inputSources) {
				const gp = source.gamepad;
				const hand = source.handedness;

				if (gp && (hand === 'left' || hand === 'right')) {
					const prev = _prevButtons[hand];
					// B / Y button (index 5): toggle pointer ray lines on press (edge).
					const b5 = !!(gp.buttons[5] && gp.buttons[5].pressed);
					if (b5 && !prev[5]) toggleRayVisibility();
					prev[5] = b5;
					// A / X button (index 4): push-to-talk — listen while held.
					const b4 = !!(gp.buttons[4] && gp.buttons[4].pressed);
					if (b4 && !prev[4]) startPTT(hand);
					if (!b4 && prev[4]) stopPTT(hand);
					prev[4] = b4;
					// Thumbstick press (index 3): collapse / restore all UI. A reliable
					// fallback for the head-locked Hide/Show-UI button.
					const b3 = !!(gp.buttons[3] && gp.buttons[3].pressed);
					if (b3 && !prev[3]) toggleUi();
					prev[3] = b3;
					// Grip / squeeze (index 1), right hand: cycle locomotion mode
					// (off → planar → free-roam).
					if (hand === 'right') {
						const b1 = !!(gp.buttons[1] && gp.buttons[1].pressed);
						if (b1 && !prev[1]) cycleLocomotionMode();
						prev[1] = b1;
					}
				}

				// Thumbsticks scroll only while locomotion is off; otherwise they
				// drive movement/turning (handled by updateLocomotion below).
				if (locomotionMode === 'off') {
					const axes = gp ? gp.axes : null;
					if (!axes) continue;
					const thumbY = axes.length >= 4 ? axes[3] : (axes.length >= 2 ? axes[1] : 0);

					if (hand === 'right' && Math.abs(thumbY) > THUMBSTICK_DEADZONE) {
						// The HTML-in-canvas mirror is not stick-scrolled. Right stick
						// stays free for yaw. Scroll that menu by pointing at it and
						// pulling the trigger (see beginHtmlInCanvasScrollDrag).
						if (!(htmlInCanvas && htmlInCanvasPanel && htmlInCanvasPanel.visible)) {
							// Right thumbstick: scroll the canvas chat panel
							chatScrollOffset += thumbY < 0 ? SCROLL_SPEED : -SCROLL_SPEED;
							chatScrollOffset = Math.max(0, chatScrollOffset);
							renderChatToCanvas();
						}
					}
					if (hand === 'left' && Math.abs(thumbY) > THUMBSTICK_DEADZONE) {
						// Left thumbstick: scroll active left-panel list. Stepped at
						// ~30 Hz and only redrawn when the offset really moved
						// (it used to redraw + re-upload every frame, even at an end).
						if (time - _stickScrollAt >= 33) {
							_stickScrollAt = time;
							const dir = thumbY < 0 ? 1 : -1;
							const clampTo = (v, max) => Math.max(0, Math.min(v, max));
							let changed = false;
							if (scenePanelSubTab === 'code') {
								const v = clampTo(codeScrollOffset + 2 * dir, _scenePanelMaxScroll.code);
								changed = v !== codeScrollOffset;
								codeScrollOffset = v;
							} else if (scenePanelSubTab === 'files') {
								const v = clampTo(filesScrollOffset + dir, _scenePanelMaxScroll.files);
								changed = v !== filesScrollOffset;
								filesScrollOffset = v;
							} else if (scenePanelSubTab === 'scenes') {
								const v = clampTo(sceneScrollOffset + dir, _scenePanelMaxScroll.scenes);
								changed = v !== sceneScrollOffset;
								sceneScrollOffset = v;
							}
							if (changed) renderScenePanel({ dom: false });
						}
					}
				}
			}

			// Locomotion: left stick moves, right stick turns.
			updateLocomotion(dt, session);
		}
	} else if (mobileXRMode) {
		// Hide reticles - no controllers in Cardboard/AR-camera mode
		for (const r of reticles) if (r) r.visible = false;
		// Gyro matches the phone to the camera feed (look by pointing the device).
		// Touch does NOT rotate the camera — in Walk-in-AR it drags the scene
		// placement instead. Hold-to-walk still nudges position if needed.
		updateCameraFromDeviceOrientation();
		if (mobileMoveHeld) applyLocomotionInput(dt, camera, 0, -1, 0, 0);
	} else {
		// Hide reticles outside XR
		for (const r of reticles) if (r) r.visible = false;
		// Desktop / phone camera: the active stock three.js control.
		cameraControls.update(dt);
	}

	// Game controllers (Gamepad API): poll once per frame before scene code
	// runs, so gsGamepad.justPressed() is fresh inside _vrAnimations.
	updateGamepads(dt);

	// Run user-injected animations from vr-exec code
	for (const animFn of window._vrAnimations) {
		try {
			animFn(time);
		} catch (e) {
			// Silently skip broken animation functions
		}
	}

	// Re-apply after user animations so children parented to the menu this
	// frame (and any material swapped onto a panel) still render on layer 1.
	applyMenuLayerPriority();

	// Match the VR render distance (see syncRenderDistance) before any render.
	syncRenderDistance();

	if (mobileXRMode === 'cardboard') {
		// Manual side-by-side stereo render (no OpenXR session to do this for us).
		stereoCam.update(camera);
		const w = window.innerWidth, h = window.innerHeight;
		renderer.setScissorTest(true);
		renderer.setScissor(0, 0, w / 2, h);
		renderer.setViewport(0, 0, w / 2, h);
		renderer.render(scene, stereoCam.cameraL);
		renderer.setScissor(w / 2, 0, w / 2, h);
		renderer.setViewport(w / 2, 0, w / 2, h);
		renderer.render(scene, stereoCam.cameraR);
		renderer.setScissorTest(false);
		renderer.setViewport(0, 0, w, h);
	} else {
		renderer.render(scene, camera);
	}
});
