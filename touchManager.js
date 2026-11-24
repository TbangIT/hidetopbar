/**
 * This file is part of Hide Top Bar
 *
 * Copyright 2026 Thomas Vogt, tbang
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Convenience from './convenience.js';

const DEBUG = Convenience.DEBUG;
const PanelBox = Main.layoutManager.panelBox;

// Top edge touch swipe zone to reveal top bar
const TOUCH_ZONE_HEIGHT_PX = 36;
const TOUCH_ZONE_X_START = 0.75;
const TOUCH_ZONE_X_END = 0.93;
const TOUCH_SWIPE_DISTANCE_PX = 20;
const TOUCH_MIN_VERTICAL_RATIO = 0.7;
const TOUCH_HOLD_MS = 4000;
const TOUCH_KEEP_NATIVE_UNFULLSCREEN = false;

// Calibrated thresholds to distinguish swipe gesture, window drag, and tap
const TOUCH_SWIPE_MAX_TIME_MS = 300;
const TOUCH_SWIPE_MIN_SPEED = 0.08;

const TOUCH_DRAG_MIN_DISTANCE_PX = 45;
const TOUCH_HOLD_TO_DRAG_MS = 450;
const TOUCH_HOLD_DRAG_DISTANCE_PX = 22;

const TOUCH_TAP_MAX_DISTANCE_PX = 18;
const TOUCH_TAP_MAX_TIME_US = 750000;

// Top-left hot corner: opening Activities during drag and drop
const TOUCH_HOT_CORNER_SIZE = 80;
const TOUCH_HOT_CORNER_DELAY_MS = 500;

const TOUCH_EVENT_TYPES = [
    Clutter.EventType.TOUCH_BEGIN,
    Clutter.EventType.TOUCH_UPDATE,
    Clutter.EventType.TOUCH_END,
    Clutter.EventType.TOUCH_CANCEL,
];

export class TouchManager {
    constructor(panelVisibilityManager, settings) {
        this._pvm = panelVisibilityManager;
        this._settings = settings;
        this._signalsHandler = new Convenience.GlobalSignalsHandler();

        this._touchActive = false;
        this._dndHotCornerActive = false;

        this._touchHoldTimeoutId = 0;
        this._touchHotCornerTimeoutId = 0;
        this._touchReplayTimeoutId = 0;
        this._touchReplayResetTimeoutId = 0;
        this._touchDragHoldTimeoutId = 0;
        this._touchSavedIntellihideBlock = null;

        this._swipeTrack = null;
        this._actorSwipeTrack = null;
        this._pointerTrack = null;
        this._replayingTouch = false;

        this._virtualPointer = null;
        this._virtualTouch = null;
        this._touchSwipeActor = null;
        this._dragMonitor = null;
        this._xdndEndId = 0;

        this._unfullscreenGesture = null;
        this._unfullscreenNotifyId = 0;
        this._panelDragGesture = null;
        this._panelDragMayRecognizeId = 0;
        this._origGetDraggableWindow = null;
        this._origOnWindowDragGestureRecognize = null;
        this._capturedEventId = 0;

        this._overviewDragSignals = [];
        this._overviewVisibilitySignals = [];
        this._modalSignals = [];

        // Watch settings changes
        this._signalsHandler.addWithLabel('settings',
            [
                this._settings,
                'changed::enable-touch-swipe',
                this._updateSettings.bind(this),
            ],
            [
                this._settings,
                'changed::enable-touch-dnd-hot-corner',
                this._updateSettings.bind(this),
            ]
        );

        this._updateSettings();
    }

    _updateSettings() {
        const wantSwipe = this._settings.get_boolean('enable-touch-swipe');
        const wantDnd = this._settings.get_boolean('enable-touch-dnd-hot-corner');

        if (wantSwipe && !this._touchActive)
            this._initTouchSwipe();
        else if (!wantSwipe && this._touchActive)
            this._destroyTouchSwipe();

        if (wantDnd && !this._dndHotCornerActive)
            this._initDndHotCorner();
        else if (!wantDnd && this._dndHotCornerActive)
            this._destroyDndHotCorner();
    }

    _initTouchSwipe() {
        this._touchActive = true;

        try {
            const seat = (global.stage.context
                ? global.stage.context.get_backend()
                : Clutter.get_default_backend()
            ).get_default_seat();
            if (seat && seat.create_virtual_device) {
                this._virtualPointer = seat.create_virtual_device(
                    Clutter.InputDeviceType.POINTER_DEVICE
                );
                this._virtualTouch = seat.create_virtual_device(
                    Clutter.InputDeviceType.TOUCHSCREEN_DEVICE
                );
            }
        } catch (e) {
            logError(e, '[hidetopbar] Failed to create virtual input devices');
            this._virtualPointer = null;
            this._virtualTouch = null;
        }

        // Top-right chrome actor: intercepts edge touches and prevents dragging underlying windows
        this._touchSwipeActor = new Clutter.Actor({
            name: 'hidetopbar-touch-swipe-trigger',
            reactive: true,
        });
        Main.layoutManager.addTopChrome(this._touchSwipeActor, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        this._touchSwipeActor.connect('event', (actor, event) => {
            return this._handleSwipeActorEvent(event);
        });

        // Monitor modal windows (e.g. dialogs, popups) to hide the swipe actor when modals are present
        this._modalSignals = [];
        const modalGroup = Main.layoutManager.modalDialogGroup;
        if (modalGroup) {
            const syncModal = () => this.syncVisibility();
            this._modalSignals.push(
                modalGroup.connect('child-added', (_group, child) => {
                    syncModal();
                    if (child && child.connect) {
                        const sid = child.connect('notify::visible', syncModal);
                        child._htbNotifyVisibleId = sid;
                    }
                }),
                modalGroup.connect('child-removed', (_group, child) => {
                    syncModal();
                    if (child && child._htbNotifyVisibleId) {
                        try {
                            child.disconnect(child._htbNotifyVisibleId);
                        } catch (_) {}
                        delete child._htbNotifyVisibleId;
                    }
                })
            );
            for (const child of modalGroup.get_children()) {
                if (child && child.connect) {
                    const sid = child.connect('notify::visible', syncModal);
                    child._htbNotifyVisibleId = sid;
                }
            }
        }

        if (Main.overview) {
            this._overviewVisibilitySignals = [
                Main.overview.connect('showing', () => this.syncVisibility()),
                Main.overview.connect('hiding', () => this.syncVisibility()),
            ];
        }

        this.updateGeometry();
        this.syncVisibility();

        this._inhibitPanelWindowDrag();
        this._updateUnfullscreenInhibition();

        this._capturedEventId = global.stage.connect(
            'captured-event',
            (stage, event) => this._handleCapturedEvent(event)
        );
    }

    _destroyTouchSwipe() {
        this._touchActive = false;

        if (this._modalSignals) {
            const modalGroup = Main.layoutManager.modalDialogGroup;
            this._modalSignals.forEach(id => {
                if (id && modalGroup)
                    modalGroup.disconnect(id);
            });
            this._modalSignals = [];
        }
        const modalGroup = Main.layoutManager.modalDialogGroup;
        if (modalGroup) {
            for (const child of modalGroup.get_children()) {
                if (child && child._htbNotifyVisibleId) {
                    try {
                        child.disconnect(child._htbNotifyVisibleId);
                    } catch (_) {}
                    delete child._htbNotifyVisibleId;
                }
            }
        }

        if (this._overviewVisibilitySignals) {
            this._overviewVisibilitySignals.forEach(id => {
                if (id && Main.overview)
                    Main.overview.disconnect(id);
            });
            this._overviewVisibilitySignals = [];
        }

        if (this._touchSwipeActor) {
            Main.layoutManager.removeChrome(this._touchSwipeActor);
            this._touchSwipeActor.destroy();
            this._touchSwipeActor = null;
        }

        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        if (this._touchHoldTimeoutId) {
            GLib.source_remove(this._touchHoldTimeoutId);
            this._touchHoldTimeoutId = 0;
        }

        this._cancelTouchReplay();
        this._cancelTouchDragTimer();

        this._virtualPointer = null;
        this._virtualTouch = null;
        this._pointerTrack = null;
        this._replayingTouch = false;
        this._actorSwipeTrack = null;
        this._swipeTrack = null;

        if (this._unfullscreenGesture) {
            if (this._unfullscreenNotifyId) {
                this._unfullscreenGesture.disconnect(this._unfullscreenNotifyId);
                this._unfullscreenNotifyId = 0;
            }
            this._unfullscreenGesture.enabled =
                this._gnomeWantsUnfullscreenGesture();
            this._unfullscreenGesture = null;
        }

        if (this._origOnWindowDragGestureRecognize) {
            Main.panel._onWindowDragGestureRecognize = this._origOnWindowDragGestureRecognize;
            this._origOnWindowDragGestureRecognize = null;
        }
        if (this._origGetDraggableWindow) {
            Main.panel._getDraggableWindowForPosition = this._origGetDraggableWindow;
            this._origGetDraggableWindow = null;
        }
        if (this._panelDragGesture) {
            this._panelDragGesture.enabled = true;
            if (this._panelDragMayRecognizeId) {
                this._panelDragGesture.disconnect(this._panelDragMayRecognizeId);
                this._panelDragMayRecognizeId = 0;
            }
            this._panelDragGesture = null;
        }
    }

    _initDndHotCorner() {
        this._dndHotCornerActive = true;

        this._dragMonitor = {
            dragMotion: (dragEvent) => {
                if (Main.overview.visible) {
                    this._cancelTouchHotCorner();
                    return DND.DragMotionResult.CONTINUE;
                }

                if (this._inTouchHotCorner(dragEvent.x, dragEvent.y)) {
                    if (!this._touchHotCornerTimeoutId) {
                        this._touchHotCornerTimeoutId = GLib.timeout_add(
                            GLib.PRIORITY_DEFAULT,
                            TOUCH_HOT_CORNER_DELAY_MS,
                            () => {
                                this._touchHotCornerTimeoutId = 0;
                                if (!Main.overview.visible)
                                    Main.overview.show();
                                return GLib.SOURCE_REMOVE;
                            }
                        );
                    }
                } else {
                    this._cancelTouchHotCorner();
                }
                return DND.DragMotionResult.CONTINUE;
            },
            dragDrop: () => {
                this._cancelTouchHotCorner();
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);

        this._overviewDragSignals = [];
        if (Main.xdndHandler) {
            this._xdndEndId = Main.xdndHandler.connect('drag-end', () => {
                this._cancelTouchHotCorner();
            });
        }
        if (Main.overview) {
            this._overviewDragSignals = [
                Main.overview.connect('item-drag-end', () => this._cancelTouchHotCorner()),
                Main.overview.connect('item-drag-cancelled', () => this._cancelTouchHotCorner()),
                Main.overview.connect('window-drag-end', () => this._cancelTouchHotCorner()),
                Main.overview.connect('window-drag-cancelled', () => this._cancelTouchHotCorner()),
            ];
        }
    }

    _destroyDndHotCorner() {
        this._dndHotCornerActive = false;
        this._cancelTouchHotCorner();

        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        if (this._xdndEndId && Main.xdndHandler) {
            Main.xdndHandler.disconnect(this._xdndEndId);
            this._xdndEndId = 0;
        }
        if (this._overviewDragSignals) {
            this._overviewDragSignals.forEach(id => {
                if (id && Main.overview)
                    Main.overview.disconnect(id);
            });
            this._overviewDragSignals = [];
        }
    }

    onMonitorsChanged() {
        this.updateGeometry();
        this.syncVisibility();
    }

    updateGeometry() {
        const monitor = this._monitorForTouch();
        if (!monitor)
            return;

        const swipeX = Math.round(monitor.x + monitor.width * TOUCH_ZONE_X_START);
        const swipeW = Math.round(monitor.width * (TOUCH_ZONE_X_END - TOUCH_ZONE_X_START));
        const panelH = (PanelBox.height > 20 && PanelBox.height <= 48)
            ? PanelBox.height
            : TOUCH_ZONE_HEIGHT_PX;
        const zoneH = Math.min(TOUCH_ZONE_HEIGHT_PX, panelH);

        if (this._touchSwipeActor) {
            this._touchSwipeActor.set_position(swipeX, monitor.y - 10);
            this._touchSwipeActor.set_size(swipeW, zoneH + 10);
        }
    }

    syncVisibility(forceVisible) {
        if (!this._touchActive)
            return;
        const allowed = this._touchSwipeAllowed();
        const visible = forceVisible !== undefined
            ? (forceVisible && allowed)
            : (this._pvm._panelIsHidden() && allowed);
        if (this._touchSwipeActor) {
            this._touchSwipeActor.visible = visible;
            this._touchSwipeActor.reactive = visible;
        }
    }

    _isTouchEvent(event) {
        if (!event)
            return false;
        if (TOUCH_EVENT_TYPES.includes(event.type()))
            return true;
        const dev = event.get_device ? event.get_device() : null;
        if (dev && dev.get_device_type && dev.get_device_type() === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE)
            return true;
        return false;
    }

    _isPointerEvent(event) {
        if (!event)
            return false;
        switch (event.type()) {
            case Clutter.EventType.BUTTON_PRESS:
            case Clutter.EventType.BUTTON_RELEASE:
            case Clutter.EventType.MOTION:
            case Clutter.EventType.PAD_BUTTON_PRESS:
            case Clutter.EventType.PAD_BUTTON_RELEASE: {
                const dev = event.get_device ? event.get_device() : null;
                if (dev && dev.get_device_type && dev.get_device_type() === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE)
                    return false;
                return true;
            }
            default:
                return false;
        }
    }

    _monitorForTouch() {
        return Main.layoutManager.primaryMonitor ??
            Main.layoutManager.monitors[0] ?? null;
    }

    _inTouchZone(x, y) {
        const monitor = this._monitorForTouch();
        if (!monitor)
            return false;
        const panelH = (PanelBox.height > 20 && PanelBox.height <= 48)
            ? PanelBox.height
            : TOUCH_ZONE_HEIGHT_PX;
        const zoneHeight = Math.min(TOUCH_ZONE_HEIGHT_PX, panelH);
        return y >= monitor.y - 10 &&
               y <= monitor.y + zoneHeight &&
               x >= monitor.x + monitor.width * TOUCH_ZONE_X_START &&
               x <= monitor.x + monitor.width * TOUCH_ZONE_X_END;
    }

    _isSwipeDirection(dx, dy) {
        return dy > 0 && dy >= TOUCH_MIN_VERTICAL_RATIO * Math.abs(dx);
    }

    _touchSwipeAllowed() {
        if (Main.overview.visible)
            return false;
        if (Main.modalCount > 0)
            return false;
        if (Main.panel.menuManager.activeMenu)
            return false;
        const modalGroup = Main.layoutManager.modalDialogGroup;
        if (modalGroup && modalGroup.get_children().some(c => c.visible && c.opacity > 0))
            return false;
        return true;
    }

    _isExtensionUiAt(x, y) {
        const modalGroup = Main.layoutManager.modalDialogGroup;
        if (modalGroup) {
            for (const child of modalGroup.get_children()) {
                if (child.visible && child.opacity > 0) {
                    const extents = child.get_transformed_extents();
                    const point = new Graphene.Point({ x, y });
                    if (extents.contains_point(point))
                        return true;
                }
            }
        }
        if (Main.panel.menuManager.activeMenu)
            return true;
        const tray = Main.messageTray;
        if (tray && tray._bannerBin && tray._bannerBin.visible) {
            const extents = tray._bannerBin.get_transformed_extents();
            const point = new Graphene.Point({ x, y });
            if (extents.contains_point(point))
                return true;
        }
        return false;
    }

    _getDraggableWindowAt(stageX, stageY) {
        const workspaceManager = global.workspace_manager;
        const workspace = workspaceManager ? workspaceManager.get_active_workspace() : null;
        if (!workspace)
            return null;

        const windows = workspace.list_windows();
        const allWindowsByStacking =
            global.display.sort_windows_by_stacking(windows).reverse();

        return allWindowsByStacking.find(metaWindow => {
            if (!metaWindow.is_on_primary_monitor() ||
                !metaWindow.showing_on_its_workspace() ||
                metaWindow.get_window_type() === Meta.WindowType.DESKTOP)
                return false;

            if (metaWindow.is_fullscreen && metaWindow.is_fullscreen())
                return false;

            if (typeof metaWindow.allows_move === 'function' && !metaWindow.allows_move())
                return false;

            const rect = metaWindow.get_frame_rect();
            const checkY = Math.max(stageY, rect.y);
            return stageX >= rect.x && stageX <= rect.x + rect.width &&
                   checkY >= rect.y && checkY <= rect.y + rect.height;
        }) ?? null;
    }

    _startWindowDrag(window, event, x, y) {
        if (!window)
            return false;

        const backend = (global.stage.context
            ? global.stage.context.get_backend()
            : Clutter.get_default_backend()
        );
        const sprite = backend.get_sprite ? backend.get_sprite(global.stage, event) : null;
        const time = event.get_time ? event.get_time() : Clutter.get_current_event_time();
        const coords = new Graphene.Point({ x, y });

        try {
            return window.begin_grab_op(
                Meta.GrabOp.MOVING,
                sprite,
                time,
                coords
            );
        } catch (e) {
            logError(e, '[hidetopbar] begin_grab_op failed');
            return false;
        }
    }

    _cancelTouchDragTimer() {
        if (this._touchDragHoldTimeoutId) {
            GLib.source_remove(this._touchDragHoldTimeoutId);
            this._touchDragHoldTimeoutId = 0;
        }
    }

    _cancelTouchReplay() {
        if (this._touchReplayTimeoutId) {
            GLib.source_remove(this._touchReplayTimeoutId);
            this._touchReplayTimeoutId = 0;
        }
        if (this._touchReplayResetTimeoutId) {
            GLib.source_remove(this._touchReplayResetTimeoutId);
            this._touchReplayResetTimeoutId = 0;
        }
        this._replayingTouch = false;
        if (this._touchSwipeActor && this._touchActive)
            this._touchSwipeActor.reactive = true;
    }

    _replayPointerTap(x, y, button = (Clutter.BUTTON_PRIMARY ?? 1)) {
        if (!this._virtualPointer)
            return;

        this._cancelTouchReplay();

        if (this._touchSwipeActor)
            this._touchSwipeActor.reactive = false;

        const monitor = this._monitorForTouch();
        const targetY = monitor ? Math.max(y, monitor.y + 2) : Math.max(y, 2);
        const targetX = monitor ? Math.min(Math.max(x, monitor.x), monitor.x + monitor.width - 1) : Math.max(x, 0);
        const timeUs = GLib.get_monotonic_time();
        try {
            this._virtualPointer.notify_absolute_motion(timeUs, targetX, targetY);
            this._virtualPointer.notify_button(
                timeUs,
                button,
                Clutter.ButtonState.PRESSED
            );
            this._virtualPointer.notify_button(
                timeUs + 15000,
                button,
                Clutter.ButtonState.RELEASED
            );
        } catch (e) {
            logError(e, '[hidetopbar] Replay pointer tap failed');
        }

        this._touchReplayResetTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            80,
            () => {
                this._touchReplayResetTimeoutId = 0;
                if (this._touchSwipeActor && this._touchActive)
                    this._touchSwipeActor.reactive = true;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _replayTouchTap(x, y) {
        if (!this._virtualTouch) {
            this._replayPointerTap(x, y);
            return;
        }

        this._cancelTouchReplay();

        if (this._touchSwipeActor)
            this._touchSwipeActor.reactive = false;

        this._replayingTouch = true;
        const monitor = this._monitorForTouch();
        const targetY = monitor ? Math.max(y, monitor.y + 2) : Math.max(y, 2);
        const targetX = monitor ? Math.min(Math.max(x, monitor.x), monitor.x + monitor.width - 1) : Math.max(x, 0);
        const timeUs = GLib.get_monotonic_time();
        const slot = 0;
        try {
            this._virtualTouch.notify_touch_down(timeUs, slot, targetX, targetY);
        } catch (e) {
            logError(e, '[hidetopbar] Replay touch down failed');
        }

        // Release touch after 35ms to produce a realistic native tap event
        // allowing Wayland and client applications to register the event across frames
        this._touchReplayTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            35,
            () => {
                this._touchReplayTimeoutId = 0;
                const upTimeUs = GLib.get_monotonic_time();
                try {
                    this._virtualTouch.notify_touch_up(upTimeUs, slot);
                } catch (e) {
                    logError(e, '[hidetopbar] Replay touch up failed');
                }

                this._touchReplayResetTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    45,
                    () => {
                        this._touchReplayResetTimeoutId = 0;
                        this._replayingTouch = false;
                        if (this._touchSwipeActor && this._touchActive)
                            this._touchSwipeActor.reactive = true;
                        return GLib.SOURCE_REMOVE;
                    }
                );

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _handleSwipeActorEvent(event) {
        if (!this._touchSwipeAllowed()) {
            this.syncVisibility(false);
            return Clutter.EVENT_PROPAGATE;
        }

        const [x, y] = event.get_coords();
        if (this._isExtensionUiAt(x, y)) {
            this.syncVisibility(false);
            return Clutter.EVENT_PROPAGATE;
        }

        if (!this._isTouchEvent(event))
            return this._handlePointerSwipeActorEvent(event);
        return this._handleTouchSwipeActorEvent(event);
    }

    _handlePointerSwipeActorEvent(event) {
        const type = event.type();

        if (type === Clutter.EventType.BUTTON_PRESS) {
            const [x, y] = event.get_coords();
            const btn = event.get_button ? event.get_button() : (Clutter.BUTTON_PRIMARY ?? 1);
            this._pointerTrack = {
                startX: x,
                startY: y,
                button: btn,
                time: event.get_time ? event.get_time() : Clutter.get_current_event_time(),
                dragStarted: false,
            };
            return Clutter.EVENT_STOP;
        }

        const track = this._pointerTrack;
        if (!track)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            const dist = Math.hypot(x - track.startX, y - track.startY);

            if (!track.dragStarted && dist >= TOUCH_TAP_MAX_DISTANCE_PX) {
                const dragWindow = this._getDraggableWindowAt(track.startX, track.startY);
                if (dragWindow) {
                    track.dragStarted = true;
                    this._startWindowDrag(dragWindow, event, x, y);
                    return Clutter.EVENT_PROPAGATE;
                }
            }

            if (track.dragStarted)
                return Clutter.EVENT_PROPAGATE;

            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            const wasDrag = track.dragStarted;
            const startX = track.startX;
            const startY = track.startY;
            const btn = track.button;
            this._pointerTrack = null;

            if (!wasDrag)
                this._replayPointerTap(startX, startY, btn);

            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _handleTouchSwipeActorEvent(event) {
        const type = event.type();
        const seq = event.get_event_sequence();
        const slot = seq ? seq.get_slot() : 0;

        if (type === Clutter.EventType.TOUCH_BEGIN) {
            const [x, y] = event.get_coords();
            this._cancelTouchReplay();
            this._cancelTouchDragTimer();

            const track = {
                slot,
                startX: x,
                startY: y,
                startTime: GLib.get_monotonic_time(),
                lastX: x,
                lastY: y,
                maxDist: 0,
                triggered: false,
                dragStarted: false,
                isHold: false,
            };
            this._actorSwipeTrack = track;
            this._setSwipeTrack(track);

            this._touchDragHoldTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                TOUCH_HOLD_TO_DRAG_MS,
                () => {
                    this._touchDragHoldTimeoutId = 0;
                    if (this._actorSwipeTrack === track && !track.triggered && !track.dragStarted) {
                        track.isHold = true;
                    }
                    return GLib.SOURCE_REMOVE;
                }
            );

            return Clutter.EVENT_STOP;
        }

        const track = this._actorSwipeTrack;
        if (!track || track.slot !== slot)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.TOUCH_UPDATE) {
            if (track.dragStarted)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            const dx = x - track.startX;
            const dy = y - track.startY;
            const dist = Math.hypot(dx, dy);
            if (dist > track.maxDist)
                track.maxDist = dist;

            track.lastX = x;
            track.lastY = y;

            const now = GLib.get_monotonic_time();
            const elapsedMs = (now - track.startTime) / 1000;
            const vertical = this._isSwipeDirection(dx, dy);

            // 1. Gesture swipe downwards to reveal panel
            if (!track.triggered && !track.isHold && vertical && dy >= TOUCH_SWIPE_DISTANCE_PX) {
                const isFast = elapsedMs <= TOUCH_SWIPE_MAX_TIME_MS ||
                               (dy / Math.max(elapsedMs, 1)) >= TOUCH_SWIPE_MIN_SPEED;
                if (isFast) {
                    track.triggered = true;
                    this._cancelTouchDragTimer();
                    this._triggerTouchShow('swipe-actor');
                    return Clutter.EVENT_STOP;
                }
            }

            // 2. Slow drag or horizontal drag to drag underlying window
            if (!track.triggered && !track.dragStarted) {
                const isHoldDrag = track.isHold && dist >= TOUCH_HOLD_DRAG_DISTANCE_PX;
                const isContinuousDrag = dist >= TOUCH_DRAG_MIN_DISTANCE_PX && (
                    !vertical ||
                    elapsedMs > TOUCH_SWIPE_MAX_TIME_MS ||
                    (dy / Math.max(elapsedMs, 1)) < TOUCH_SWIPE_MIN_SPEED
                );

                if (isHoldDrag || isContinuousDrag) {
                    const dragWindow = this._getDraggableWindowAt(track.startX, track.startY);
                    if (dragWindow) {
                        track.dragStarted = true;
                        this._cancelTouchDragTimer();
                        this._startWindowDrag(dragWindow, event, x, y);
                        return Clutter.EVENT_PROPAGATE;
                    }
                }
            }

            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
            this._cancelTouchDragTimer();

            const wasTriggered = track.triggered;
            const wasDrag = track.dragStarted;
            const maxDist = track.maxDist;
            const durationUs = track.startTime ? (GLib.get_monotonic_time() - track.startTime) : 0;
            const startX = track.startX;
            const startY = track.startY;

            this._actorSwipeTrack = null;
            this._setSwipeTrack(null);

            if (type === Clutter.EventType.TOUCH_END && !wasTriggered && !wasDrag) {
                if (maxDist < TOUCH_TAP_MAX_DISTANCE_PX && durationUs < TOUCH_TAP_MAX_TIME_US) {
                    this._replayTouchTap(startX, startY);
                }
            }
            return wasDrag ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _cancelTouchHotCorner() {
        if (this._touchHotCornerTimeoutId) {
            GLib.source_remove(this._touchHotCornerTimeoutId);
            this._touchHotCornerTimeoutId = 0;
        }
    }

    _inTouchHotCorner(x, y) {
        const monitor = this._monitorForTouch();
        if (!monitor)
            return false;
        return x >= monitor.x - 10 &&
               x <= monitor.x + TOUCH_HOT_CORNER_SIZE &&
               y >= monitor.y - 10 &&
               y <= monitor.y + TOUCH_HOT_CORNER_SIZE;
    }

    _ensureUnfullscreenGesture() {
        if (this._unfullscreenGesture)
            return;
        const actions = global.stage.get_actions
            ? global.stage.get_actions() : [];
        this._unfullscreenGesture = actions.find(a => {
            const name = a.get_name ? a.get_name() : a.name;
            return name === 'Window unfullscreen top drag';
        }) || null;
        if (this._unfullscreenGesture) {
            this._unfullscreenNotifyId = this._unfullscreenGesture.connect(
                'notify::enabled', () => this._enforceUnfullscreenBlock()
            );
            this._unfullscreenGesture.enabled = this._unfullscreenShouldBeEnabled();
        }
    }

    _gnomeWantsUnfullscreenGesture() {
        const w = global.display.focus_window;
        return !!(w && w.is_fullscreen());
    }

    _unfullscreenShouldBeEnabled() {
        if (!TOUCH_KEEP_NATIVE_UNFULLSCREEN || this._pvm._panelIsHidden())
            return false;
        return this._gnomeWantsUnfullscreenGesture();
    }

    _enforceUnfullscreenBlock() {
        const g = this._unfullscreenGesture;
        if (!g || !this._touchActive)
            return;
        if (g.enabled && !this._unfullscreenShouldBeEnabled())
            g.enabled = false;
    }

    _updateUnfullscreenInhibition() {
        if (!this._touchActive)
            return;

        this._ensureUnfullscreenGesture();
        if (this._unfullscreenGesture) {
            const want = this._unfullscreenShouldBeEnabled();
            if (this._unfullscreenGesture.enabled !== want)
                this._unfullscreenGesture.enabled = want;
        }

        if (this._panelDragGesture) {
            if (this._swipeTrack !== null || this._touchHoldTimeoutId !== 0 || this._pvm._panelIsHidden())
                this._panelDragGesture.enabled = false;
            else
                this._panelDragGesture.enabled = true;
        }
    }

    _inhibitPanelWindowDrag() {
        if (typeof Main.panel._onWindowDragGestureRecognize === 'function') {
            this._origOnWindowDragGestureRecognize = Main.panel._onWindowDragGestureRecognize;
            const self = this;
            Main.panel._onWindowDragGestureRecognize = function() {
                if (self._pvm._panelIsHidden() || self._swipeTrack !== null || self._touchHoldTimeoutId !== 0)
                    return;
                const curr = Clutter.get_current_event();
                if (!curr || !self._isPointerEvent(curr))
                    return;
                return self._origOnWindowDragGestureRecognize.call(this);
            };
        }

        if (typeof Main.panel._getDraggableWindowForPosition === 'function') {
            this._origGetDraggableWindow = Main.panel._getDraggableWindowForPosition;
            const self = this;
            Main.panel._getDraggableWindowForPosition = function(stageX) {
                if (self._pvm._panelIsHidden() || self._swipeTrack !== null || self._touchHoldTimeoutId !== 0)
                    return null;
                const curr = Clutter.get_current_event();
                if (!curr || !self._isPointerEvent(curr))
                    return null;
                return self._origGetDraggableWindow.call(this, stageX);
            };
        }

        this._panelDragGesture =
            (Main.panel.get_action && Main.panel.get_action('window-drag')) ||
            Main.panel._clickGesture ||
            null;
        if (this._panelDragGesture) {
            this._panelDragMayRecognizeId = this._panelDragGesture.connect(
                'may-recognize',
                gesture => {
                    if (this._pvm._panelIsHidden() || this._swipeTrack !== null || this._touchHoldTimeoutId !== 0)
                        return false;
                    const curr = Clutter.get_current_event();
                    if (!curr || !this._isPointerEvent(curr))
                        return false;
                    return true;
                }
            );
        }
    }

    _setSwipeTrack(track) {
        this._swipeTrack = track;
        this._updateUnfullscreenInhibition();
    }

    _handleCapturedEvent(event) {
        if (this._replayingTouch)
            return Clutter.EVENT_PROPAGATE;

        if (this._touchSwipeActor && this._touchSwipeActor.visible && !this._touchSwipeAllowed())
            this.syncVisibility(false);

        const type = event.type();
        if (!TOUCH_EVENT_TYPES.includes(type))
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.TOUCH_BEGIN) {
            const [x, y] = event.get_coords();
            if (this._touchHoldTimeoutId)
                this._handleTouchWhileShown(x, y);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _handleTouchWhileShown(x, y) {
        if (Main.overview.visible)
            return;
        const monitor = this._monitorForTouch();
        if (!monitor)
            return;

        if (y <= monitor.y + PanelBox.height || this._inTouchZone(x, y)) {
            this._restartTouchHold();
            return;
        }

        if (Main.panel.menuManager.activeMenu)
            return;

        GLib.source_remove(this._touchHoldTimeoutId);
        this._touchHoldTimeoutId = 0;
        this._releaseTouchHold();
    }

    _triggerTouchShow(source) {
        DEBUG(`TouchManager._triggerTouchShow (${source})`);
        if (this._touchSavedIntellihideBlock === null)
            this._touchSavedIntellihideBlock = this._pvm._intellihideBlock;

        this._pvm._preventHide = true;
        this._pvm._intellihideBlock = true;

        this._pvm.show(
            this._settings.get_double('animation-time-autohide'),
            'touch-swipe'
        );
        this._restartTouchHold();
    }

    _restartTouchHold() {
        if (this._touchHoldTimeoutId)
            GLib.source_remove(this._touchHoldTimeoutId);
        this._touchHoldTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TOUCH_HOLD_MS,
            () => {
                this._touchHoldTimeoutId = 0;
                this._releaseTouchHold();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _releaseTouchHold() {
        if (!this._touchActive)
            return;
        this._pvm._preventHide = false;
        this._pvm._intellihideBlock = this._touchSavedIntellihideBlock ?? false;
        this._touchSavedIntellihideBlock = null;

        if (Main.overview.visible)
            return;

        if (this._settings.get_boolean('enable-intellihide') &&
            !this._pvm._intellihideBlock &&
            !this._pvm._intellihide.getOverlapStatus()) {
            this._pvm._updatePreventHide();
            return;
        }

        if (Main.panel.menuManager.activeMenu) {
            this._pvm._handleMenus();
            return;
        }

        this._pvm.hide(
            this._settings.get_double('animation-time-autohide'),
            'touch-release'
        );
    }

    destroy() {
        this._destroyTouchSwipe();
        this._destroyDndHotCorner();
        this._signalsHandler.destroy();
    }
}
