const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {FrameTree} = ChromeUtils.import('chrome://juggler/content/content/FrameTree.js');
const {NetworkMonitor} = ChromeUtils.import('chrome://juggler/content/content/NetworkMonitor.js');
const {ScrollbarManager} = ChromeUtils.import('chrome://juggler/content/content/ScrollbarManager.js');
const {SimpleChannel} = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const {RuntimeAgent} = ChromeUtils.import('chrome://juggler/content/content/RuntimeAgent.js');
const {PageAgent} = ChromeUtils.import('chrome://juggler/content/content/PageAgent.js');

const ALL_PERMISSIONS = [
  'geo',
  'microphone',
  'camera',
  'desktop-notification',
];

const scrollbarManager = new ScrollbarManager(docShell);
let frameTree;
let networkMonitor;
const helper = new Helper();
const messageManager = this;

const sessions = new Map();

function createContentSession(channel, sessionId) {
  const runtimeAgent = new RuntimeAgent(channel, sessionId);
  const pageAgent = new PageAgent(messageManager, channel, sessionId, runtimeAgent, frameTree, networkMonitor);
  sessions.set(sessionId, [runtimeAgent, pageAgent]);

  runtimeAgent.enable();
  pageAgent.enable();
}

function disposeContentSession(sessionId) {
  const handlers = sessions.get(sessionId);
  sessions.delete(sessionId);
  for (const handler of handlers)
    handler.dispose();
}

function setGeolocationOverrideInDocShell(geolocation) {
  if (geolocation) {
    docShell.setGeolocationOverride({
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
    docShell.setGeolocationOverride(null);
  }
}

function setOnlineOverrideInDocShell(override) {
  if (!override) {
    docShell.onlineOverride = Ci.nsIDocShell.ONLINE_OVERRIDE_NONE;
    return;
  }
  docShell.onlineOverride = override === 'online' ?
      Ci.nsIDocShell.ONLINE_OVERRIDE_ONLINE : Ci.nsIDocShell.ONLINE_OVERRIDE_OFFLINE;
}

function initialize() {
  let response = sendSyncMessage('juggler:content-ready', {})[0];
  if (!response)
    response = { sessionIds: [], browserContextOptions: {}, waitForInitialNavigation: false };

  const { sessionIds, browserContextOptions, waitForInitialNavigation } = response;
  const { userAgent, bypassCSP, javaScriptDisabled, viewport, scriptsToEvaluateOnNewDocument, bindings, locale, geolocation, onlineOverride } = browserContextOptions;

  if (userAgent !== undefined)
    docShell.customUserAgent = userAgent;
  if (bypassCSP !== undefined)
    docShell.bypassCSPEnabled = bypassCSP;
  if (javaScriptDisabled !== undefined)
    docShell.allowJavascript = !javaScriptDisabled;
  if (locale !== undefined)
    docShell.languageOverride = locale;
  if (geolocation !== undefined)
    setGeolocationOverrideInDocShell(geolocation);
  if (onlineOverride !== undefined)
    setOnlineOverrideInDocShell(onlineOverride);
  if (viewport !== undefined) {
    docShell.contentViewer.overrideDPPX = viewport.deviceScaleFactor || this._initialDPPX;
    docShell.deviceSizeIsPageSize = viewport.isMobile;
    docShell.touchEventsOverride = viewport.hasTouch ? Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_ENABLED : Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_NONE;
    scrollbarManager.setFloatingScrollbars(viewport.isMobile);
  }

  frameTree = new FrameTree(docShell, waitForInitialNavigation);
  for (const script of scriptsToEvaluateOnNewDocument || [])
    frameTree.addScriptToEvaluateOnNewDocument(script);
  for (const { name, script } of bindings || [])
    frameTree.addBinding(name, script);
  networkMonitor = new NetworkMonitor(docShell, frameTree);

  const channel = SimpleChannel.createForMessageManager('content::page', messageManager);

  for (const sessionId of sessionIds)
    createContentSession(channel, sessionId);

  channel.register('', {
    attach({sessionId}) {
      createContentSession(channel, sessionId);
    },

    detach({sessionId}) {
      disposeContentSession(sessionId);
    },

    addScriptToEvaluateOnNewDocument(script) {
      frameTree.addScriptToEvaluateOnNewDocument(script);
    },

    addBinding(name, script) {
      frameTree.addBinding(name, script);
    },

    setGeolocationOverride(geolocation) {
      setGeolocationOverrideInDocShell(geolocation);
    },

    setOnlineOverride(override) {
      setOnlineOverrideInDocShell(override);
    },

    async ensurePermissions(permissions) {
      const checkPermissions = () => {
        for (const permission of ALL_PERMISSIONS) {
          const actual = Services.perms.testExactPermissionFromPrincipal(this._docShell.domWindow.document.nodePrincipal, permission);
          const expected = permissions.include(permission) ? Ci.nsIPermissionManager.ALLOW_ACTION : Ci.nsIPermissionManager.DENY_ACTION;
          if (actual !== expected)
            return false;
        }
        return true;
      }

      if (checkPermissions())
        return;

      // Track all 'perm-changed' events and wait until permissions are expected.
      await new Promise(resolve => {
        const listeners = [helper.addObserver(() => {
          if (!checkPermission())
            return;
          helper.removeListeners(listeners);
          resolve();
        }, 'perm-changed')];
      });
    },

    dispose() {
    },
  });

  const gListeners = [
    helper.addEventListener(messageManager, 'unload', msg => {
      helper.removeListeners(gListeners);
      channel.dispose();

      for (const sessionId of sessions.keys())
        disposeContentSession(sessionId);

      scrollbarManager.dispose();
      networkMonitor.dispose();
      frameTree.dispose();
    }),
  ];
}

initialize();
