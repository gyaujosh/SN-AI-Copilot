// inject.js — Runs in ServiceNow's page context
// Has full access to window, g_form, GlideRecord, g_ck, etc.
// Communicates with the content script via namespaced CustomEvents (snai2-*).
//
// Duplicate-execution hardening:
//  - self-guard: a second injection of this script becomes a no-op
//  - extId filtering: only handles events dispatched by ITS OWN content script,
//    so a second installed copy of the extension can't double-execute requests
//  - requestId dedupe: a repeated request id is dropped
//  - the snai2-* namespace means older extension builds (listening on snai-*)
//    never see these events at all
//  - form fills verify the loaded form IS the target record before saving

(function () {
  'use strict';

  var EXT_ID = '';
  try {
    EXT_ID = (document.currentScript && document.currentScript.dataset && document.currentScript.dataset.snaiExt) || '';
  } catch (e) {}

  // Self-guard against double injection (per extension id).
  var guardKey = '__snaiInjected_' + (EXT_ID || 'default');
  if (window[guardKey]) return;
  window[guardKey] = true;

  // Ignore events from a different extension copy. (Our content script always
  // stamps extId; anything else is foreign.)
  function isForeign(detail) {
    if (!EXT_ID) return false;
    return !detail || detail.extId !== EXT_ID;
  }

  // Drop repeated request ids (belt & suspenders against double dispatch).
  var seenOrder = [];
  var seenIds = {};
  function isDuplicateRequest(requestId) {
    if (!requestId) return false;
    if (seenIds[requestId]) return true;
    seenIds[requestId] = true;
    seenOrder.push(requestId);
    if (seenOrder.length > 200) {
      delete seenIds[seenOrder.shift()];
    }
    return false;
  }

  function emit(name, detail) {
    detail = detail || {};
    detail.extId = EXT_ID;
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  // Versioned, side-effect-free readiness round trip. Older helper versions do
  // not answer this event, so the extension asks for a refresh instead of using
  // an incompatible relay or installing duplicate mutation listeners.
  document.addEventListener('snai2-health-request', function (e) {
    if (isForeign(e.detail)) return;
    emit('snai2-health-response', { nonce: e.detail.nonce, version: 1 });
  });

  // Gather page context and send it back to the content script
  function gatherContext() {
    var context = {
      url: window.location.href,
      hostname: window.location.hostname,
      pathname: window.location.pathname,
      instance: window.location.hostname.replace('.service-now.com', ''),
      table: null,
      sysId: null,
      fields: [],
      values: {},
      isForm: false,
      isList: false,
      isScriptEditor: false,
      uiType: 'unknown',
      scope: null,
      updateSet: null
    };

    // The session token (g_ck) is deliberately not part of the context: API
    // calls read it at request time, so it never travels to the extension.

    // Detect UI type
    if (document.querySelector('[macroponent-namespace]')) {
      context.uiType = 'polaris';
    } else if (document.querySelector('#navpage_header_bar')) {
      context.uiType = 'ui16';
    } else if (document.querySelector('.app-header')) {
      context.uiType = 'studio';
    }

    // Get form context
    try {
      if (typeof g_form !== 'undefined' && g_form) {
        context.isForm = true;
        context.table = g_form.getTableName();

        // Get sys_id
        try {
          context.sysId = g_form.getUniqueValue();
        } catch (e) {}

        // Get all fields and their values
        try {
          var elements = g_form.elements || [];
          for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            var fieldName = el.fieldName;
            if (fieldName) {
              context.fields.push({
                name: fieldName,
                label: g_form.getLabelOf(fieldName) || fieldName,
                type: el.type || 'unknown',
                mandatory: g_form.isMandatory(fieldName),
                readOnly: false,
                visible: g_form.isFieldVisible(fieldName)
              });
              try {
                context.values[fieldName] = g_form.getValue(fieldName);
              } catch (e) {
                context.values[fieldName] = '';
              }
            }
          }
        } catch (e) {}

        // Get display values for reference fields
        try {
          for (var j = 0; j < context.fields.length; j++) {
            var fld = context.fields[j];
            if (fld.type === 'reference' || fld.type === 'glide_list') {
              try {
                var displayVal = g_form.getDisplayBox(fld.name);
                if (displayVal) {
                  context.values[fld.name + '_display'] = displayVal.value || '';
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    // Get list context
    try {
      if (typeof GlideList2 !== 'undefined') {
        var lists = document.querySelectorAll('.list_header_cell');
        if (lists.length > 0) {
          context.isList = true;
          try {
            var targetEl = document.querySelector('#sys_target');
            if (targetEl) {
              context.table = targetEl.value;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // Check for script editor (Monaco or native)
    try {
      if (document.querySelector('.monaco-editor') ||
          document.querySelector('textarea.sn-code-editor') ||
          document.querySelector('#CodeMirrorDiv')) {
        context.isScriptEditor = true;
      }
    } catch (e) {}

    // Get current scope
    try {
      if (typeof window.NOW !== 'undefined' && window.NOW.user) {
        context.scope = window.NOW.user.currentScope || null;
      }
    } catch (e) {}

    return context;
  }

  // Send context to content script
  function sendContext() {
    emit('snai2-context-response', { context: gatherContext() });
  }

  // Listen for context requests from content script
  document.addEventListener('snai2-context-request', function (e) {
    if (isForeign(e.detail)) return;
    sendContext();
  });

  // Only the Table and Aggregate APIs on this instance, for one table or one
  // record: the relay carries the user's session token, so it must never be
  // steered to any other endpoint, whatever path it is handed.
  var API_PATH = /^\/api\/now\/(table|stats)\/[a-z0-9_]+(\/[0-9a-f]{32})?$/;
  function allowedApiUrl(url) {
    try {
      var parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin && API_PATH.test(parsed.pathname);
    } catch (e) {
      return false;
    }
  }

  // Listen for API call requests from content script
  document.addEventListener('snai2-api-request', function (e) {
    if (isForeign(e.detail)) return;
    var request = e.detail;
    if (isDuplicateRequest(request.requestId)) return;
    if (!allowedApiUrl(request.url)) {
      emit('snai2-api-response', {
        requestId: request.requestId,
        data: { error: { message: 'Blocked: only the Table and Aggregate APIs can be called.' }, _status: 400 },
        error: null,
        status: 400
      });
      return;
    }

    var headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    };

    // Add CSRF token if available — from this window, or gsft_main's frame when
    // the top window has none (UI16 framesets, Studio). Without it a write
    // comes back 401, which the envelope status below now reports.
    try {
      var apiToken = '';
      if (typeof g_ck !== 'undefined' && g_ck) apiToken = g_ck;
      else {
        var mainFrame = document.getElementById('gsft_main');
        if (mainFrame && mainFrame.contentWindow && mainFrame.contentWindow.g_ck) apiToken = mainFrame.contentWindow.g_ck;
      }
      if (apiToken) headers['X-UserToken'] = apiToken;
    } catch (ex) {}

    var method = request.method || 'GET';
    var fetchOptions = {
      method: method,
      headers: headers
    };

    if (request.body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      fetchOptions.body = JSON.stringify(request.body);
    }

    fetch(request.url, fetchOptions)
      .then(function (response) {
        var status = response.status;
        // DELETE returns 204 (no content) — don't try to parse empty body as JSON
        if (status === 204 || response.headers.get('content-length') === '0') {
          return { data: { _status: status }, status: status };
        }
        return response.json()
          .then(function (data) {
            // _status stays stamped inside data for consumers that predate the
            // envelope-level status (bridgeAuthFailed, tabs still running an
            // older copy of this script after an extension update).
            if (data && typeof data === 'object' && !Array.isArray(data)) data._status = status;
            return { data: data, status: status };
          })
          .catch(function () {
            // Non-JSON body (usually the login page) — session likely expired.
            return { data: { _status: status, _parseError: true }, status: status };
          });
      })
      .then(function (result) {
        // error stays null for any HTTP answer — the status field is how a
        // 401/403 refusal reaches the worker. Only a network failure sets error.
        emit('snai2-api-response', {
          requestId: request.requestId,
          data: result.data,
          error: null,
          status: result.status
        });
      })
      .catch(function (error) {
        emit('snai2-api-response', {
          requestId: request.requestId,
          data: null,
          error: error.message
        });
      });
  });

  // Create records via xmlhttp.do → SNAICopilotHelper Script Include (server-side GlideRecord)
  // No GlideAjax dependency — direct fetch to /xmlhttp.do, works from any frame
  document.addEventListener('snai2-glideajax-create', function (e) {
    if (isForeign(e.detail)) return;
    var request = e.detail;
    if (isDuplicateRequest(request.requestId)) return;

    // Get g_ck token from current window or gsft_main
    var token = '';
    try {
      if (typeof g_ck !== 'undefined' && g_ck) token = g_ck;
      else {
        var f = document.getElementById('gsft_main');
        if (f && f.contentWindow && f.contentWindow.g_ck) token = f.contentWindow.g_ck;
      }
    } catch (ex) {}

    var params = new URLSearchParams();
    params.set('sysparm_processor', 'SNAICopilotHelper');
    params.set('sysparm_name', 'createRecord');
    params.set('sysparm_table', request.table);
    params.set('sysparm_fields', JSON.stringify(request.fields));

    fetch('/xmlhttp.do', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-UserToken': token },
      body: params.toString()
    })
    .then(function (r) { return r.text(); })
    .then(function (txt) {
      // Parse XML response — answer is in the "answer" ATTRIBUTE of the <xml> element
      var answer = '';
      try {
        var parser = new DOMParser();
        var doc = parser.parseFromString(txt, 'text/xml');
        var xmlEl = doc.querySelector('xml');
        if (xmlEl && xmlEl.getAttribute('answer')) {
          answer = xmlEl.getAttribute('answer');
        } else {
          var answerEl = doc.querySelector('answer');
          answer = answerEl ? answerEl.textContent : txt;
        }
      } catch (e2) { answer = txt; }

      var result;
      try { result = JSON.parse(answer); }
      catch (e3) { result = { sys_id: null, error: 'Parse failed: ' + answer.substring(0, 200) }; }

      emit('snai2-glideajax-response', {
        requestId: request.requestId,
        sys_id: result.sys_id,
        error: result.error,
        needs_form_fill: result.needs_form_fill,
        catalog_variable_name: result.catalog_variable_name
      });
    })
    .catch(function (error) {
      emit('snai2-glideajax-response', { requestId: request.requestId, sys_id: null, error: error.message });
    });
  });

  // Returns an error string if the loaded form is NOT the record we intend to
  // edit (wrong record, new-record form after a redirect, etc.). Saving in that
  // state would INSERT a stray/duplicate record — never allow it.
  function formMismatch(gForm, expectedSysId) {
    var currentId = '';
    try { currentId = String(gForm.getUniqueValue() || ''); } catch (ex) {}
    if (currentId.toLowerCase() === String(expectedSysId || '').toLowerCase()) return null;
    return 'Form fill aborted: loaded form is "' + (currentId || 'new record') +
      '", expected "' + expectedSysId + '". Not saving to avoid creating a stray record.';
  }

  // Form-fill catalog_variable through g_form in a form context, then save and clean up.
  document.addEventListener('snai2-form-fill', function (e) {
    if (isForeign(e.detail)) return;
    var request = e.detail;
    if (isDuplicateRequest(request.requestId)) return;
    var requestId = request.requestId;
    var recordUrl = '/catalog_ui_policy_action.do?sys_id=' + request.sysId;
    var gsft = document.getElementById('gsft_main');
    var isUI16 = !!gsft;
    var originalUrl = window.location.href;

    function dispatchResult(result) {
      result = result || {};
      result.requestId = requestId;
      emit('snai2-glideajax-response', result);
    }

    function cleanup() {
      if (isUI16 && originalUrl) {
        gsft.src = originalUrl;
      } else if (!isUI16 && gsft && gsft.id) {
        var frame = document.getElementById(gsft.id);
        if (frame) frame.remove();
      }
    }

    if (isUI16) {
      try { originalUrl = gsft.contentWindow.location.pathname + gsft.contentWindow.location.search; } catch(ex) {}
      gsft.src = recordUrl;
    } else {
      var frameId = 'snai-form-fill-' + requestId;
      var hiddenFrame = document.createElement('iframe');
      hiddenFrame.id = frameId;
      hiddenFrame.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      hiddenFrame.src = recordUrl;
      document.body.appendChild(hiddenFrame);
      gsft = hiddenFrame;
    }

    var attempts = 0;
    var maxAttempts = 30;
    var checkInterval = setInterval(function() {
      attempts++;
      try {
        var gForm = gsft.contentWindow.g_form;
        if (gForm && typeof gForm.setValue === 'function') {
          // Never save a form that isn't the record we created.
          var mismatch = formMismatch(gForm, request.sysId);
          if (mismatch) {
            clearInterval(checkInterval);
            cleanup();
            dispatchResult({ error: mismatch });
            return;
          }
          // Check if the catalog_variable dropdown has options loaded
          var selectEl = null;
          try { selectEl = gsft.contentWindow.document.getElementById('catalog_ui_policy_action.catalog_variable'); } catch(ex) {}
          if (!selectEl || !selectEl.options || selectEl.options.length < 2) {
            // Dropdown not populated yet — keep waiting (don't clear interval)
            if (attempts >= maxAttempts) {
              clearInterval(checkInterval);
              cleanup();
              dispatchResult({ error: 'catalog_variable dropdown never populated (' + (selectEl && selectEl.options ? selectEl.options.length : 0) + ' options)' });
            }
            return; // Try again next tick
          }
          clearInterval(checkInterval);
          gForm.setValue('catalog_variable', request.variableName);
          setTimeout(function () {
            try {
              gForm.save();
            } catch (saveErr) {
              try {
                gForm.submit();
              } catch (submitErr) {
                cleanup();
                dispatchResult({ error: 'Form fill save failed: ' + submitErr.message });
                return;
              }
            }

            setTimeout(function () {
              cleanup();
              dispatchResult({ success: true });
            }, 2000);
          }, 1000);
        } else if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          cleanup();
          dispatchResult({ error: 'g_form not available after ' + maxAttempts + ' attempts' });
        }
      } catch(ex) {
        if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          cleanup();
          dispatchResult({ error: 'Form fill error: ' + ex.message });
        }
      }
    }, 500);
  });

  // Generic form-fill: load any record form in hidden iframe, set a field, save
  document.addEventListener('snai2-form-fill-generic', function (e) {
    if (isForeign(e.detail)) return;
    var request = e.detail;
    if (isDuplicateRequest(request.requestId)) return;
    var requestId = request.requestId;
    var recordUrl = '/' + request.tableName + '.do?sys_id=' + request.sysId;
    var fieldName = request.fieldName;
    var value = request.value;

    function dispatchResult(result) {
      result = result || {};
      result.requestId = requestId;
      emit('snai2-glideajax-response', result);
    }

    // The table and sys_id become the form's URL: only a plain table name and
    // a 32-hex sys_id, so the frame can only ever load a record form here.
    if (!/^[a-z0-9_]+$/.test(String(request.tableName)) || !/^[0-9a-f]{32}$/.test(String(request.sysId))) {
      dispatchResult({ error: 'Invalid table name or sys_id. Nothing was changed.' });
      return;
    }

    var frameId = 'snai-generic-fill-' + requestId;
    var hiddenFrame = document.createElement('iframe');
    hiddenFrame.id = frameId;
    hiddenFrame.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    hiddenFrame.src = recordUrl;
    document.body.appendChild(hiddenFrame);

    function removeFrame() {
      var f = document.getElementById(frameId);
      if (f) f.remove();
    }

    var attempts = 0;
    var maxAttempts = 30;
    var checkInterval = setInterval(function() {
      attempts++;
      try {
        var gForm = hiddenFrame.contentWindow.g_form;
        if (gForm && typeof gForm.setValue === 'function') {
          // Never save a form that isn't the record we created.
          var mismatch = formMismatch(gForm, request.sysId);
          if (mismatch) {
            clearInterval(checkInterval);
            removeFrame();
            dispatchResult({ error: mismatch });
            return;
          }
          // Wait for the target dropdown to have options (for IO: dependent fields)
          if (value && value.indexOf('IO:') === 0) {
            var selectEl = null;
            try {
              var fullFieldId = request.tableName + '.' + fieldName;
              selectEl = hiddenFrame.contentWindow.document.getElementById(fullFieldId);
            } catch(ex) {}
            if (!selectEl || !selectEl.options || selectEl.options.length < 2) {
              if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                removeFrame();
                dispatchResult({ error: fieldName + ' dropdown never populated (' + (selectEl && selectEl.options ? selectEl.options.length : 0) + ' options)' });
              }
              return;
            }
          }
          clearInterval(checkInterval);
          gForm.setValue(fieldName, value);
          setTimeout(function () {
            try { gForm.save(); } catch (e2) { try { gForm.submit(); } catch(e3) {} }
            setTimeout(function () {
              removeFrame();
              dispatchResult({ success: true });
            }, 2000);
          }, 1000);
        } else if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          removeFrame();
          dispatchResult({ error: 'g_form not available after ' + maxAttempts + ' attempts' });
        }
      } catch(ex) {
        if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          removeFrame();
          dispatchResult({ error: 'Form fill error: ' + ex.message });
        }
      }
    }, 500);
  });

  // Auto-send context when page is ready
  setTimeout(sendContext, 1000);

  // Re-send context when form changes (if g_form exists)
  try {
    if (typeof g_form !== 'undefined' && g_form) {
      // Poll for changes every 5 seconds (lightweight)
      setInterval(function () {
        sendContext();
      }, 5000);
    }
  } catch (e) {}

})();
