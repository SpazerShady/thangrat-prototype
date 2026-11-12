/*
 * Minimal stand-in runtime so the .dc.html screens can run outside the
 * Claude Design canvas (e.g. on GitHub Pages).
 *
 * Supports exactly what these screens use:
 *   - {{path}} holes in text and attributes (dotted lookups and literals)
 *   - <sc-if value="{{x}}"> and <sc-for list="{{xs}}" as="x"> (with $index)
 *   - onClick / onChange / onKeyDown handlers returned from renderVals()
 *   - class Component extends DCLogic with state / setState / forceUpdate
 *     and componentDidMount / componentDidUpdate / componentWillUnmount
 *   - <helmet> contents moved into <head>
 * Rendering and DOM diffing are done by Preact (vendor/preact.umd.js, MIT).
 */
(function () {
  'use strict';

  var here = document.currentScript && document.currentScript.src;
  var base = here ? here.replace(/[^/]*$/, '') : './';

  // Canvas asset URLs -> files in this repo
  var BLOB_MAP = {
    '/_blob/745e58c465e92bf487df051d92f4d186': base + '../assets/tangrat-logo.png'
  };

  // Hide the raw template until it is rendered
  var hideStyle = document.createElement('style');
  hideStyle.textContent = 'x-dc{display:none!important}';
  document.head.appendChild(hideStyle);

  var preactReady = false;
  var domReady = document.readyState !== 'loading';
  var started = false;

  var s = document.createElement('script');
  s.src = base + 'vendor/preact.umd.js';
  s.onload = function () { preactReady = true; maybeStart(); };
  s.onerror = function () { console.error('[dc] could not load Preact'); };
  document.head.appendChild(s);

  if (!domReady) {
    document.addEventListener('DOMContentLoaded', function () { domReady = true; maybeStart(); });
  }

  function maybeStart() {
    if (started || !preactReady || !domReady) return;
    started = true;
    try { start(); } catch (e) { console.error('[dc] start failed', e); }
  }

  // ---------- DCLogic base class ----------
  var scheduleRender = null;

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (update, cb) {
    var part = typeof update === 'function' ? update(this.state, this.props) : update;
    if (part == null) { if (cb) cb(); return; }
    var prev = this.state;
    this.state = Object.assign({}, this.state, part);
    if (scheduleRender) scheduleRender(prev, cb);
  };
  DCLogic.prototype.forceUpdate = function (cb) {
    if (scheduleRender) scheduleRender(this.state, cb);
  };
  DCLogic.prototype.renderVals = function () { return {}; };

  // ---------- template evaluation ----------
  var WHOLE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;
  var HOLE = /\{\{\s*([^{}]+?)\s*\}\}/g;

  function lookup(path, vals, scope) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (path === 'undefined') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var m = /^'(.*)'$|^"(.*)"$/.exec(path);
    if (m) return m[1] != null ? m[1] : m[2];
    var parts = path.split('.');
    var head = parts[0];
    var cur = scope && Object.prototype.hasOwnProperty.call(scope, head) ? scope[head] : (vals ? vals[head] : undefined);
    for (var i = 1; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function str(v) { return v == null ? '' : String(v); }

  function evalAttr(text, vals, scope) {
    var m = WHOLE.exec(text);
    if (m) return lookup(m[1], vals, scope);
    if (text.indexOf('{{') < 0) return text;
    return text.replace(HOLE, function (_, p) { return str(lookup(p, vals, scope)); });
  }

  var TEXTY = { text: 1, number: 1, date: 1, email: 1, tel: 1, search: 1, url: 1, password: 1, '': 1 };

  function eventProp(attrName, node) {
    var ev = attrName.slice(2); // after "on"
    if (ev === 'change') {
      var tag = node.localName;
      var type = (node.getAttribute('type') || '').toLowerCase();
      if (tag === 'textarea' || (tag === 'input' && TEXTY[type])) return 'onInput';
      return 'onChange';
    }
    var map = { click: 'onClick', keydown: 'onKeyDown', keyup: 'onKeyUp', input: 'onInput', submit: 'onSubmit', focus: 'onFocus', blur: 'onBlur' };
    return map[ev] || ('on' + ev.charAt(0).toUpperCase() + ev.slice(1));
  }

  function toV(node, vals, scope, h) {
    if (node.nodeType === 3) {
      var t = node.nodeValue;
      if (t.indexOf('{{') < 0) return t;
      return t.replace(HOLE, function (_, p) { return str(lookup(p, vals, scope)); });
    }
    if (node.nodeType !== 1) return null;
    var tag = node.localName;

    if (tag === 'sc-if') {
      var cond = evalAttr(node.getAttribute('value') || '', vals, scope);
      return cond ? kids(node, vals, scope, h) : null;
    }
    if (tag === 'sc-for') {
      var list = evalAttr(node.getAttribute('list') || '', vals, scope);
      var as = node.getAttribute('as') || 'item';
      if (!Array.isArray(list)) return null;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var sc = Object.assign({}, scope || {});
        sc[as] = list[i];
        sc.$index = i;
        out.push(kids(node, vals, sc, h));
      }
      return out;
    }
    if (tag === 'helmet') return null;

    var props = {};
    var attrs = node.attributes;
    for (var a = 0; a < attrs.length; a++) {
      var name = attrs[a].name;
      var raw = attrs[a].value;
      if (name.indexOf('hint-') === 0) continue;
      if (name.length > 2 && name.slice(0, 2) === 'on') {
        var fn = evalAttr(raw, vals, scope);
        if (typeof fn === 'function') props[eventProp(name, node)] = fn;
        continue;
      }
      var v = evalAttr(raw, vals, scope);
      if (name === 'src' && typeof v === 'string' && BLOB_MAP[v]) v = BLOB_MAP[v];
      if (name === 'value' || name === 'checked' || name === 'disabled' || name === 'selected') {
        if (name === 'value') { props.value = v == null ? '' : v; continue; }
        props[name] = v === '' ? true : !!v;
        continue;
      }
      if (name.indexOf('aria-') === 0 && typeof v === 'boolean') v = String(v);
      props[name] = v;
    }
    return h(tag, props, kids(node, vals, scope, h));
  }

  function kids(node, vals, scope, h) {
    var out = [];
    var c = node.childNodes;
    for (var i = 0; i < c.length; i++) {
      var v = toV(c[i], vals, scope, h);
      if (v != null) out.push(v);
    }
    return out;
  }

  // ---------- boot ----------
  function start() {
    var P = window.preact;
    var h = P.h;
    var xdc = document.querySelector('x-dc');
    var script = document.querySelector('script[data-dc-script]');
    if (!xdc || !script) { console.error('[dc] missing <x-dc> or logic script'); return; }

    // helmet -> head
    var helmet = xdc.querySelector('helmet');
    if (helmet) {
      while (helmet.firstChild) {
        var n = helmet.firstChild;
        helmet.removeChild(n);
        if (n.nodeType === 1) document.head.appendChild(n);
      }
    }

    // keep the template detached so it never runs or loads anything itself
    var template = [];
    for (var i = 0; i < xdc.childNodes.length; i++) {
      if (xdc.childNodes[i].localName !== 'helmet') template.push(xdc.childNodes[i]);
    }
    xdc.parentNode.removeChild(xdc);

    var Component;
    try {
      Component = new Function('DCLogic', script.textContent + '\n;return Component;')(DCLogic);
    } catch (e) { console.error('[dc] logic script failed', e); return; }

    var root = document.createElement('div');
    root.id = 'dc-root';
    document.body.appendChild(root);

    var inst = new Component({});
    if (!inst.state) inst.state = {};
    var mounted = false;
    var pending = false;
    var prevForUpdate = null;
    var callbacks = [];

    function paint() {
      var vals;
      try { vals = inst.renderVals() || {}; } catch (e) { console.error('[dc] renderVals failed', e); vals = {}; }
      var tree = template.map(function (n) { return toV(n, vals, null, h); }).filter(function (x) { return x != null; });
      P.render(h(P.Fragment, null, tree), root);
    }

    scheduleRender = function (prevState, cb) {
      if (cb) callbacks.push(cb);
      if (!mounted) return;
      if (!pending) { pending = true; prevForUpdate = prevState; Promise.resolve().then(flush); }
    };

    function flush() {
      pending = false;
      var prev = prevForUpdate;
      paint();
      var cbs = callbacks; callbacks = [];
      if (typeof inst.componentDidUpdate === 'function') {
        try { inst.componentDidUpdate(inst.props, prev); } catch (e) { console.error(e); }
      }
      cbs.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
    }

    paint();
    mounted = true;
    if (typeof inst.componentDidMount === 'function') {
      try { inst.componentDidMount(); } catch (e) { console.error('[dc] componentDidMount failed', e); }
    }
    if (callbacks.length) flush();

    window.addEventListener('pagehide', function () {
      if (typeof inst.componentWillUnmount === 'function') {
        try { inst.componentWillUnmount(); } catch (e) {}
      }
    });
  }
})();
