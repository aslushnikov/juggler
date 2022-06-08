"use strict";

const { FrameTree } = ChromeUtils.import('chrome://juggler/content/content/FrameTree.js');
const { Helper } = ChromeUtils.import('chrome://juggler/content/Helper.js');
const { PageAgent } = ChromeUtils.import('chrome://juggler/content/content/PageAgent.js');
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { SimpleChannel } = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');

const Ci = Components.interfaces;
const helper = new Helper();

class JugglerFrameChild extends JSWindowActorChild {
  constructor() {
    super();

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
    if (!this._pageAgent)
      return;
    if (aEvent.type === 'DOMContentLoaded') {
      this._pageAgent._onDOMContentLoaded(aEvent);
    } else if (aEvent.type === 'error') {
      this._pageAgent._onError(aEvent);
    }
  }

  actorCreated() {
    const frameTreeCookie = Services.cpmm.sharedData.get('juggler:frametree-cookie-' + this.browsingContext.browserId);
    if (!frameTreeCookie)
      return;

    this._channel = SimpleChannel.createForActor('content::frame', this);
    const userContextId = this.browsingContext.originAttributes.userContextId;
    const {
      bindings = [],
      settings = {}
    } = Services.cpmm.sharedData.get('juggler:usercontextidcookie:' + userContextId);
    // Enforce focused state for all top level documents.
    this.docShell.overrideHasFocus = true;
    this.docShell.forceActiveState = true;

    this._frameTree = new FrameTree(this.docShell);
    for (const [name, value] of Object.entries(settings)) {
      if (value !== undefined)
        this.applySetting[name](value);
    }
    for (const { worldName, name, script } of bindings)
      this._frameTree.addBinding(worldName, name, script);
    this._frameTree.setInitScripts(frameTreeCookie.initScripts);
    this._pageAgent = new PageAgent(this._channel, this._frameTree, this.contentWindow);
    this._eventListeners = [
      helper.on(this._frameTree, FrameTree.Events.WillProcessSwap, () => false && this._dispose()),
      this._channel.register('', {
        setInitScripts(scripts) {
          this._frameTree.setInitScripts(scripts);
        },

        addBinding({worldName, name, script}) {
          this._frameTree.addBinding(worldName, name, script);
        },

        applyContextSetting({name, value}) {
          this.applySetting[name](value);
        },

        ensurePermissions() {
          // noop, just a rountrip.
        },

        hasFailedToOverrideTimezone() {
          return this._failedToOverrideTimezone;
        },

        async awaitViewportDimensions({ width, height, deviceSizeIsPageSize }) {
          this.docShell.deviceSizeIsPageSize = deviceSizeIsPageSize;
          const win = this.docShell.domWindow;
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
  }

  _dispose() {
    if (!this._pageAgent)
      return;
    this._pageAgent.dispose();
    this._pageAgent = null;
    this._frameTree.dispose();
    this._frameTree = null;
    this._channel.dispose();
    this._channel = null;
    helper.removeListeners(this._eventListeners);

  }

  didDestroy() {
    this._dispose();
  }

  receiveMessage() { }
}

var EXPORTED_SYMBOLS = ['JugglerFrameChild'];
