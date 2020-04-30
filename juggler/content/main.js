const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {FrameTree} = ChromeUtils.import('chrome://juggler/content/content/FrameTree.js');
const {NetworkMonitor} = ChromeUtils.import('chrome://juggler/content/content/NetworkMonitor.js');
const {ScrollbarManager} = ChromeUtils.import('chrome://juggler/content/content/ScrollbarManager.js');
const {SimpleChannel} = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const {PageAgent} = ChromeUtils.import('chrome://juggler/content/content/PageAgent.js');

const scrollbarManager = new ScrollbarManager(docShell);
let frameTree;
let networkMonitor;
const helper = new Helper();
const messageManager = this;

const sessions = new Map();

function createContentSession(channel, sessionId) {
  const pageAgent = new PageAgent(messageManager, channel, sessionId, frameTree, networkMonitor);
  sessions.set(sessionId, [pageAgent]);
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
  const loadContext = docShell.QueryInterface(Ci.nsILoadContext);
  const userContextId = loadContext.originAttributes.userContextId;

  let response = sendSyncMessage('juggler:content-ready', { userContextId })[0];
  if (!response)
    response = { sessionIds: [], browserContextOptions: {} };

  const { sessionIds, browserContextOptions } = response;
  const { userAgent, bypassCSP, javaScriptDisabled, viewport, scriptsToEvaluateOnNewDocument, bindings, locale, timezoneId, geolocation, onlineOverride, colorScheme } = browserContextOptions;

  let failedToOverrideTimezone = false;
  if (timezoneId)
    failedToOverrideTimezone = !docShell.overrideTimezone(timezoneId);
  if (userAgent !== undefined)
    docShell.browsingContext.customUserAgent = userAgent;
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
    docShell.touchEventsOverride = viewport.hasTouch ? Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_ENABLED : Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_NONE;
    docShell.deviceSizeIsPageSize = true;
    scrollbarManager.setFloatingScrollbars(viewport.isMobile);
  }

  // Enforce focused state for all top level documents.
  docShell.overrideHasFocus = true;

  frameTree = new FrameTree(docShell);
  if (colorScheme !== undefined)
    frameTree.setColorScheme(colorScheme);
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

    setColorScheme(colorScheme) {
      frameTree.setColorScheme(colorScheme);
    },

    ensurePermissions() {
      // noop, just a rountrip.
    },

    hasFailedToOverrideTimezone() {
      return failedToOverrideTimezone;
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
