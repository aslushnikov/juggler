const {t, checkScheme} = ChromeUtils.import('chrome://juggler/content/protocol/PrimitiveTypes.js');

// Protocol-specific types.
const targetTypes = {};
targetTypes.TargetInfo = {
  type: t.Enum(['page', 'browser']),
  targetId: t.String,
  browserContextId: t.Optional(t.String),
  url: t.String,
  // PageId of parent tab, if any.
  openerId: t.Optional(t.String),
};

const browserTypes = {};

browserTypes.CookieOptions = {
  name: t.String,
  value: t.String,
  url: t.Optional(t.String),
  domain: t.Optional(t.String),
  path: t.Optional(t.String),
  secure: t.Optional(t.Boolean),
  httpOnly: t.Optional(t.Boolean),
  sameSite: t.Optional(t.Enum(['Strict', 'Lax', 'None'])),
  expires: t.Optional(t.Number),
};

browserTypes.Cookie = {
  name: t.String,
  domain: t.String,
  path: t.String,
  value: t.String,
  expires: t.Number,
  size: t.Number,
  httpOnly: t.Boolean,
  secure: t.Boolean,
  session: t.Boolean,
  sameSite: t.Enum(['Strict', 'Lax', 'None']),
};

const pageTypes = {};
pageTypes.DOMPoint = {
  x: t.Number,
  y: t.Number,
};

pageTypes.BoundingBox = {
  x: t.Number,
  y: t.Number,
  width: t.Number,
  height: t.Number,
};

pageTypes.Viewport = {
  width: t.Number,
  height: t.Number,
  deviceScaleFactor: t.Number,
  isMobile: t.Boolean,
  hasTouch: t.Boolean,
  isLandscape: t.Boolean,
};

pageTypes.DOMQuad = {
  p1: pageTypes.DOMPoint,
  p2: pageTypes.DOMPoint,
  p3: pageTypes.DOMPoint,
  p4: pageTypes.DOMPoint,
};

pageTypes.TouchPoint = {
  x: t.Number,
  y: t.Number,
  radiusX: t.Optional(t.Number),
  radiusY: t.Optional(t.Number),
  rotationAngle: t.Optional(t.Number),
  force: t.Optional(t.Number),
};

pageTypes.Clip = {
  x: t.Number,
  y: t.Number,
  width: t.Number,
  height: t.Number,
};


const runtimeTypes = {};
runtimeTypes.RemoteObject = {
  type: t.Optional(t.Enum(['object', 'function', 'undefined', 'string', 'number', 'boolean', 'symbol', 'bigint'])),
  subtype: t.Optional(t.Enum(['array', 'null', 'node', 'regexp', 'date', 'map', 'set', 'weakmap', 'weakset', 'error', 'proxy', 'promise', 'typedarray'])),
  objectId: t.Optional(t.String),
  unserializableValue: t.Optional(t.Enum(['Infinity', '-Infinity', '-0', 'NaN'])),
  value: t.Any
};

runtimeTypes.ObjectProperty = {
  name: t.String,
  value: runtimeTypes.RemoteObject,
};

runtimeTypes.ScriptLocation = {
  columnNumber: t.Number,
  lineNumber: t.Number,
  url: t.String,
};

runtimeTypes.ExceptionDetails = {
  text: t.Optional(t.String),
  stack: t.Optional(t.String),
  value: t.Optional(t.Any),
};

runtimeTypes.CallFunctionArgument = {
  objectId: t.Optional(t.String),
  unserializableValue: t.Optional(t.Enum(['Infinity', '-Infinity', '-0', 'NaN'])),
  value: t.Any,
};

const axTypes = {};
axTypes.AXTree = {
  role: t.String,
  name: t.String,
  children: t.Optional(t.Array(t.Recursive(axTypes, 'AXTree'))),

  selected: t.Optional(t.Boolean),
  focused: t.Optional(t.Boolean),
  pressed: t.Optional(t.Boolean),
  focusable: t.Optional(t.Boolean),
  haspopup: t.Optional(t.Boolean),
  required: t.Optional(t.Boolean),
  invalid: t.Optional(t.Boolean),
  modal: t.Optional(t.Boolean),
  editable: t.Optional(t.Boolean),
  busy: t.Optional(t.Boolean),
  multiline: t.Optional(t.Boolean),
  readonly: t.Optional(t.Boolean),
  checked: t.Optional(t.Enum(['mixed', true])),
  expanded: t.Optional(t.Boolean),
  disabled: t.Optional(t.Boolean),
  multiselectable: t.Optional(t.Boolean),

  value: t.Optional(t.String),
  description: t.Optional(t.String),

  value: t.Optional(t.String),
  roledescription: t.Optional(t.String),
  valuetext: t.Optional(t.String),
  orientation: t.Optional(t.String),
  autocomplete: t.Optional(t.String),
  keyshortcuts: t.Optional(t.String),

  level: t.Optional(t.Number),

  tag: t.Optional(t.String),

  foundObject: t.Optional(t.Boolean),
}

const Browser = {
  targets: ['browser'],

  events: {},

  types: browserTypes,

  methods: {
    'close': {},
    'getInfo': {
      returns: {
        userAgent: t.String,
        version: t.String,
      },
    },
    'setIgnoreHTTPSErrors': {
      params: {
        enabled: t.Boolean,
      },
    },
    'grantPermissions': {
      params: {
        origin: t.String,
        browserContextId: t.Optional(t.String),
        permissions: t.Array(t.Enum([
          'geo', 'microphone', 'camera', 'desktop-notifications'
        ])),
      },
    },
    'resetPermissions': {
      params: {
        browserContextId: t.Optional(t.String),
      }
    },
    'setCookies': {
      params: {
        browserContextId: t.Optional(t.String),
        cookies: t.Array(browserTypes.CookieOptions),
      }
    },
    'clearCookies': {
      params: {
        browserContextId: t.Optional(t.String),
      }
    },
    'getCookies': {
      params: {
        browserContextId: t.Optional(t.String)
      },
      returns: {
        cookies: t.Array(browserTypes.Cookie),
      },
    },
  },
};

const Target = {
  targets: ['browser'],

  types: targetTypes,

  events: {
    'attachedToTarget': {
      sessionId: t.String,
      targetInfo: targetTypes.TargetInfo,
    },
    'detachedFromTarget': {
      sessionId: t.String,
    },
    'targetCreated': targetTypes.TargetInfo,
    'targetDestroyed': targetTypes.TargetInfo,
    'targetInfoChanged': targetTypes.TargetInfo,
  },

  methods: {
    // Start emitting tagOpened/tabClosed events
    'enable': {},
    'attachToTarget': {
      params: {
        targetId: t.String,
      },
      returns: {
        sessionId: t.String,
      },
    },
    'newPage': {
      params: {
        browserContextId: t.Optional(t.String),
      },
      returns: {
        targetId: t.String,
      }
    },
    'createBrowserContext': {
      returns: {
        browserContextId: t.String,
      },
    },
    'removeBrowserContext': {
      params: {
        browserContextId: t.String,
      },
    },
    'getBrowserContexts': {
      returns: {
        browserContextIds: t.Array(t.String),
      },
    },
  },
};

const networkTypes = {};

networkTypes.HTTPHeader = {
  name: t.String,
  value: t.String,
};

networkTypes.SecurityDetails = {
  protocol: t.String,
  subjectName: t.String,
  issuer: t.String,
  validFrom: t.Number,
  validTo: t.Number,
};

const Network = {
  targets: ['page'],
  types: networkTypes,
  events: {
    'requestWillBeSent': {
      // frameId may be absent for redirected requests.
      frameId: t.Optional(t.String),
      requestId: t.String,
      // RequestID of redirected request.
      redirectedFrom: t.Optional(t.String),
      postData: t.Optional(t.String),
      headers: t.Array(networkTypes.HTTPHeader),
      suspended: t.Optional(t.Boolean),
      url: t.String,
      method: t.String,
      navigationId: t.Optional(t.String),
      cause: t.String,
    },
    'responseReceived': {
      securityDetails: t.Nullable(networkTypes.SecurityDetails),
      requestId: t.String,
      fromCache: t.Boolean,
      remoteIPAddress: t.Optional(t.String),
      remotePort: t.Optional(t.Number),
      status: t.Number,
      statusText: t.String,
      headers: t.Array(networkTypes.HTTPHeader),
    },
    'requestFinished': {
      requestId: t.String,
    },
    'requestFailed': {
      requestId: t.String,
      errorCode: t.String,
    },
  },
  methods: {
    'enable': {},
    'setRequestInterception': {
      params: {
        enabled: t.Boolean,
      },
    },
    'setExtraHTTPHeaders': {
      params: {
        headers: t.Array(networkTypes.HTTPHeader),
      },
    },
    'abortSuspendedRequest': {
      params: {
        requestId: t.String,
      },
    },
    'resumeSuspendedRequest': {
      params: {
        requestId: t.String,
        headers: t.Optional(t.Array(networkTypes.HTTPHeader)),
      },
    },
    'getResponseBody': {
      params: {
        requestId: t.String,
      },
      returns: {
        base64body: t.String,
        evicted: t.Optional(t.Boolean),
      },
    },
  },
};

const Runtime = {
  targets: ['page'],
  types: runtimeTypes,
  events: {
    'executionContextCreated': {
      executionContextId: t.String,
      auxData: t.Any,
    },
    'executionContextDestroyed': {
      executionContextId: t.String,
    },
    'console': {
      executionContextId: t.String,
      args: t.Array(runtimeTypes.RemoteObject),
      type: t.String,
      location: runtimeTypes.ScriptLocation,
    },
  },
  methods: {
    'enable': {
      params: {},
    },
    'evaluate': {
      params: {
        // Pass frameId here.
        executionContextId: t.String,
        expression: t.String,
        returnByValue: t.Optional(t.Boolean),
      },

      returns: {
        result: t.Optional(runtimeTypes.RemoteObject),
        exceptionDetails: t.Optional(runtimeTypes.ExceptionDetails),
      }
    },
    'callFunction': {
      params: {
        // Pass frameId here.
        executionContextId: t.String,
        functionDeclaration: t.String,
        returnByValue: t.Optional(t.Boolean),
        args: t.Array(runtimeTypes.CallFunctionArgument),
      },

      returns: {
        result: t.Optional(runtimeTypes.RemoteObject),
        exceptionDetails: t.Optional(runtimeTypes.ExceptionDetails),
      }
    },
    'disposeObject': {
      params: {
        executionContextId: t.String,
        objectId: t.String,
      },
    },

    'getObjectProperties': {
      params: {
        executionContextId: t.String,
        objectId: t.String,
      },

      returns: {
        properties: t.Array(runtimeTypes.ObjectProperty),
      }
    },
  },
};

const Page = {
  targets: ['page'],

  types: pageTypes,
  events: {
    'eventFired': {
      frameId: t.String,
      name: t.Enum(['load', 'DOMContentLoaded']),
    },
    'uncaughtError': {
      frameId: t.String,
      message: t.String,
      stack: t.String,
    },
    'frameAttached': {
      frameId: t.String,
      parentFrameId: t.Optional(t.String),
    },
    'frameDetached': {
      frameId: t.String,
    },
    'navigationStarted': {
      frameId: t.String,
      navigationId: t.String,
      url: t.String,
    },
    'navigationCommitted': {
      frameId: t.String,
      // |navigationId| can only be null in response to enable.
      navigationId: t.Optional(t.String),
      url: t.String,
      // frame.id or frame.name
      name: t.String,
    },
    'navigationAborted': {
      frameId: t.String,
      navigationId: t.String,
      errorText: t.String,
    },
    'sameDocumentNavigation': {
      frameId: t.String,
      url: t.String,
    },
    'dialogOpened': {
      dialogId: t.String,
      type: t.Enum(['prompt', 'alert', 'confirm', 'beforeunload']),
      message: t.String,
      defaultValue: t.Optional(t.String),
    },
    'dialogClosed': {
      dialogId: t.String,
    },
    'bindingCalled': {
      executionContextId: t.String,
      name: t.String,
      payload: t.Any,
    },
    'fileChooserOpened': {
      executionContextId: t.String,
      element: runtimeTypes.RemoteObject
    },
  },

  methods: {
    'enable': {
      params: {},
    },
    'close': {
      params: {
        runBeforeUnload: t.Optional(t.Boolean),
      },
    },
    'setFileInputFiles': {
      params: {
        frameId: t.String,
        objectId: t.String,
        files: t.Array(t.String),
      },
    },
    'addBinding': {
      params: {
        name: t.String,
      },
    },
    'setViewport': {
      params: {
        viewport: t.Nullable(pageTypes.Viewport),
      },
    },
    'setUserAgent': {
      params: {
        userAgent: t.Nullable(t.String),
      },
    },
    'setEmulatedMedia': {
      params: {
        type: t.Optional(t.Enum(['screen', 'print', ''])),
        colorScheme: t.Optional(t.Enum(['dark', 'light', 'no-preference'])),
      },
    },
    'setBypassCSP': {
      params: {
        enabled: t.Boolean
      }
    },
    'setCacheDisabled': {
      params: {
        cacheDisabled: t.Boolean,
      },
    },
    'setJavascriptEnabled': {
      params: {
        enabled: t.Boolean,
      },
    },
    'contentFrame': {
      params: {
        frameId: t.String,
        objectId: t.String,
      },
      returns: {
        frameId: t.Nullable(t.String),
      },
    },
    'addScriptToEvaluateOnNewDocument': {
      params: {
        script: t.String,
      },
      returns: {
        scriptId: t.String,
      }
    },
    'removeScriptToEvaluateOnNewDocument': {
      params: {
        scriptId: t.String,
      },
    },
    'navigate': {
      params: {
        frameId: t.String,
        url: t.String,
        referer: t.Optional(t.String),
      },
      returns: {
        navigationId: t.Nullable(t.String),
        navigationURL: t.Nullable(t.String),
      }
    },
    'goBack': {
      params: {
        frameId: t.String,
      },
      returns: {
        navigationId: t.Nullable(t.String),
        navigationURL: t.Nullable(t.String),
      }
    },
    'goForward': {
      params: {
        frameId: t.String,
      },
      returns: {
        navigationId: t.Nullable(t.String),
        navigationURL: t.Nullable(t.String),
      }
    },
    'reload': {
      params: {
        frameId: t.String,
      },
      returns: {
        navigationId: t.String,
        navigationURL: t.String,
      }
    },
    'getBoundingBox': {
      params: {
        frameId: t.String,
        objectId: t.String,
      },
      returns: {
        boundingBox: t.Nullable(pageTypes.BoundingBox),
      },
    },
    'screenshot': {
      params: {
        mimeType: t.Enum(['image/png', 'image/jpeg']),
        fullPage: t.Optional(t.Boolean),
        clip: t.Optional(pageTypes.Clip),
      },
      returns: {
        data: t.String,
      }
    },
    'getContentQuads': {
      params: {
        frameId: t.String,
        objectId: t.String,
      },
      returns: {
        quads: t.Array(pageTypes.DOMQuad),
      },
    },
    'dispatchKeyEvent': {
      params: {
        type: t.String,
        key: t.String,
        keyCode: t.Number,
        location: t.Number,
        code: t.String,
        repeat: t.Boolean,
      }
    },
    'dispatchTouchEvent': {
      params: {
        type: t.Enum(['touchStart', 'touchEnd', 'touchMove', 'touchCancel']),
        touchPoints: t.Array(pageTypes.TouchPoint),
        modifiers: t.Number,
      },
      returns: {
        defaultPrevented: t.Boolean,
      }
    },
    'dispatchMouseEvent': {
      params: {
        type: t.String,
        button: t.Number,
        x: t.Number,
        y: t.Number,
        modifiers: t.Number,
        clickCount: t.Optional(t.Number),
        buttons: t.Number,
      }
    },
    'insertText': {
      params: {
        text: t.String,
      }
    },
    'handleDialog': {
      params: {
        dialogId: t.String,
        accept: t.Boolean,
        promptText: t.Optional(t.String),
      },
    },
    'setInterceptFileChooserDialog': {
      params: {
        enabled: t.Boolean,
      },
    },
  },
};


const Accessibility = {
  targets: ['page'],
  types: axTypes,
  events: {},
  methods: {
    'getFullAXTree': {
      params: {
        objectId: t.Optional(t.String),
      },
      returns: {
        tree: axTypes.AXTree
      },
    }
  }
}

this.protocol = {
  domains: {Browser, Target, Page, Runtime, Network, Accessibility},
};
this.checkScheme = checkScheme;
this.EXPORTED_SYMBOLS = ['protocol', 'checkScheme'];
