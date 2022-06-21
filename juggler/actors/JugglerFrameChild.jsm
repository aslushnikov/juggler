"use strict";

const { FrameTree } = ChromeUtils.import('chrome://juggler/content/content/FrameTree.js');
const { Helper } = ChromeUtils.import('chrome://juggler/content/Helper.js');
const { PageAgent } = ChromeUtils.import('chrome://juggler/content/content/PageAgent.js');
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');

const Ci = Components.interfaces;
const helper = new Helper();


let sameProcessInstanceNumber = 0;

class JugglerFrameChild extends JSWindowActorChild {
  constructor() {
    super();

    this._eventListeners = [];
    this._failedToOverrideTimezone = false;
    this.applySetting = {
      geolocation: (geolocation) => {
        if (geolocation) {
          this.docShell.setGeolocationOverride({
            coords: {
              latitude: geolocation.latitude,
              longitude: geolocation.longitude,
              accuracy: geolocation.accuracy,
              altitude: NaN,
              altitudeAccuracy: NaN,
              heading: NaN,
              speed: NaN,
            },
            address: null,
            timestamp: Date.now()
          });
        } else {
          this.docShell.setGeolocationOverride(null);
        }
      },

      onlineOverride: (onlineOverride) => {
        if (!onlineOverride) {
          this.docShell.onlineOverride = Ci.nsIDocShell.ONLINE_OVERRIDE_NONE;
          return;
        }
        this.docShell.onlineOverride = onlineOverride === 'online' ?
            Ci.nsIDocShell.ONLINE_OVERRIDE_ONLINE : Ci.nsIDocShell.ONLINE_OVERRIDE_OFFLINE;
      },

      bypassCSP: (bypassCSP) => {
        this.docShell.bypassCSPEnabled = bypassCSP;
      },

      timezoneId: (timezoneId) => {
        this._failedToOverrideTimezone = !this.docShell.overrideTimezone(timezoneId);
      },

      locale: (locale) => {
        this.docShell.languageOverride = locale;
      },

      scrollbarsHidden: (hidden) => {
        this._frameTree.setScrollbarsHidden(hidden);
      },

      colorScheme: (colorScheme) => {
        this._frameTree.setColorScheme(colorScheme);
      },

      reducedMotion: (reducedMotion) => {
        this._frameTree.setReducedMotion(reducedMotion);
      },

      forcedColors: (forcedColors) => {
        this._frameTree.setForcedColors(forcedColors);
      },
    };
  }

  handleEvent(aEvent) {
    if (!this._initialized)
      return;
    if (aEvent.target !== this.document)
      return;
    if (aEvent.type === 'DOMContentLoaded') {
      this._pageAgent._onDOMContentLoaded(aEvent);
    } else if (aEvent.type === 'DOMDocElementInserted') {
      // this._frameTree._mainFrame._onGlobalObjectCreated();
    } else if (aEvent.type === 'error') {
      this._pageAgent._onError(aEvent);
    } else if (aEvent.type === 'pagehide') {
      // this._frameTree._mainFrame._onGlobalObjectDestroyed();
    }
  }

  actorCreated() {
    if (this.document.documentURI.startsWith('moz-extension://'))
      return;
    this._debugName = this.browsingContext.id + '-' + (++sameProcessInstanceNumber);

    this._initialized = true;
    const userContextId = this.browsingContext.originAttributes.userContextId;
    const contextCrossProcessCookie = Services.cpmm.sharedData.get('juggler:context-cookie-' + userContextId);
    const pageCrossProcessCookie = Services.cpmm.sharedData.get('juggler:frametree-cookie-' + this.browsingContext.browserId);

    const cookie = {
      bindings: new Map([
        ...(contextCrossProcessCookie?.bindings ?? []),
        ...(pageCrossProcessCookie?.bindings ?? [])
      ]),
      initScripts: [
        ...(contextCrossProcessCookie?.initScripts ?? []),
        ...(pageCrossProcessCookie?.initScripts ?? [])
      ],
      interceptFileChooserDialog: pageCrossProcessCookie?.interceptFileChooserDialog ?? false,
      contextSettings: contextCrossProcessCookie?.settings ?? {},
    };

    this._channel = SimpleChannel.createForActor('content::frame', this);

    // Enforce focused state for all top level documents.
    this.docShell.overrideHasFocus = true;
    this.docShell.forceActiveState = true;

    this._frameTree = new FrameTree(this.docShell, this.contentWindow);
    this._frameTree._runtime._actor = this;
    this._pageAgent = new PageAgent(this._channel, this._frameTree, this.contentWindow);

    for (const [name, value] of Object.entries(cookie.contextSettings)) {
      if (value !== undefined)
        this.applySetting[name](value);
    }
    for (const { worldName, name, script } of cookie.bindings.values())
      this._frameTree.addBinding(worldName, name, script);
    this._frameTree.setInitScripts(cookie.initScripts);
    this._pageAgent._setInterceptFileChooserDialog({
      enabled: cookie.interceptFileChooserDialog,
    });

    const self = this;
    this._eventListeners = [
      helper.on(this._frameTree, FrameTree.Events.FrameDetached, frame => {
        // if the main frame got detached, then we should dispose everything.
        if (frame === this._frameTree.mainFrame())
          this._dispose();
      }),
      this._channel.register('', {
        setInitScripts(scripts) {
          self._frameTree.setInitScripts(scripts);
        },

        addBinding({worldName, name, script}) {
          self._frameTree.addBinding(worldName, name, script);
        },

        applyContextSetting({name, value}) {
          self.applySetting[name](value);
        },

        ensurePermissions() {
          // noop, just a rountrip.
        },

        hasFailedToOverrideTimezone() {
          return self._failedToOverrideTimezone;
        },

        getFrameName() {
          return self._frameTree._mainFrame.name();
        },

        async awaitViewportDimensions({ width, height, deviceSizeIsPageSize }) {
          self.docShell.deviceSizeIsPageSize = deviceSizeIsPageSize;
          const win = self.docShell.domWindow;
          if (win.innerWidth === width && win.innerHeight === height)
            return;
          await new Promise(resolve => {
            const listener = helper.addEventListener(win, 'resize', () => {
              if (win.innerWidth === width && win.innerHeight === height) {
                helper.removeListeners([listener]);
                resolve();
              }
            });
          });
        },

        dispose() {
        },
      }),
    ];

    this._frameTree._onDOMWindowCreated(this.contentWindow);
  }

  _dispose() {
    if (!this._initialized)
      return;
    this._initialized = false;
    // Reset transport so that all messages
    // will be pending and will not throw any errors.
    this._channel.resetTransport();
    this._pageAgent.dispose();
    this._pageAgent = null;
    this._frameTree.dispose();
    this._frameTree = null;
    helper.removeListeners(this._eventListeners);
  }

  didDestroy() {
    this._dispose();
  }

  receiveMessage() { }
}

function channelId(channel) {
  if (channel instanceof Ci.nsIIdentChannel) {
    const identChannel = channel.QueryInterface(Ci.nsIIdentChannel);
    return String(identChannel.channelId);
  }
  return helper.generateId();
}

var EXPORTED_SYMBOLS = ['JugglerFrameChild'];
