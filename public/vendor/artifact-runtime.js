// Artifact runtime — single source of truth for React-artifact CDN loading,
// JSX transpiling, and component mounting. Used by both:
//   - react-shell.html       (streaming iframe)
//   - buildReactHtml() in app.js  (new-tab / download / source view)
//
// Exposed as window.ArtifactRuntime with these async APIs:
//   loadPeers()       → ensure React + ReactDOM (+ Sucrase + Lucide if needed)
//   transpile(code)   → JSX → JS (Sucrase first, lazy Babel fallback)
//   mountReact(el, code) → loadPeers + transpile + factory + ReactDOM.render
//
// Tailwind is left to the page (it's a stylesheet, not a runtime concern).

(function () {
  // Detect the origin we were loaded from. window.location.origin can be
  // unusable when this script runs inside a blob: page (standalone tabs);
  // sniffing the <script> tag's absolute src is reliable in that case too.
  let _origin = '';
  try {
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i].src;
      if (src && src.indexOf('/vendor/artifact-runtime.js') !== -1) {
        _origin = new URL(src).origin;
        break;
      }
    }
  } catch (_) {}
  const localUrl = (path) => (_origin ? _origin + path : path);

  const CDN = {
    react: [
      'https://cdn.bootcdn.net/ajax/libs/react/18.3.1/umd/react.production.min.js',
      'https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js',
    ],
    reactDom: [
      'https://cdn.bootcdn.net/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js',
      'https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js',
    ],
    sucrase: [localUrl('/vendor/sucrase.min.js')],
    babel: [
      'https://cdn.bootcdn.net/ajax/libs/babel-standalone/7.26.5/babel.min.js',
      'https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js',
    ],
    // Full ~400 KB UMD with all 1500+ icons. Loaded once per artifact iframe;
    // cross-iframe cache (shared origin via shell src) means subsequent
    // artifacts get it from disk cache.
    lucide: [
      'https://cdn.jsdelivr.net/npm/lucide@latest/dist/umd/lucide.min.js',
      'https://unpkg.com/lucide@latest/dist/umd/lucide.min.js',
    ],
  };

  const _scriptCache = {};
  function loadScript(urls) {
    const list = Array.isArray(urls) ? urls : [urls];
    const key = list[0];
    if (_scriptCache[key]) return _scriptCache[key];
    _scriptCache[key] = new Promise((resolve, reject) => {
      const tryNext = (i) => {
        if (i >= list.length) {
          reject(new Error('All CDN sources failed: ' + list.join(', ')));
          return;
        }
        const s = document.createElement('script');
        s.src = list[i];
        s.crossOrigin = 'anonymous';
        s.onload = resolve;
        s.onerror = () => tryNext(i + 1);
        document.head.appendChild(s);
      };
      tryNext(0);
    });
    return _scriptCache[key];
  }

  let _peersPromise = null;
  function loadPeers() {
    if (_peersPromise) return _peersPromise;
    const need = [];
    if (!window.React) need.push(loadScript(CDN.react));
    if (!window.ReactDOM) need.push(loadScript(CDN.reactDom));
    if (!window.Sucrase) need.push(loadScript(CDN.sucrase));
    if (!window.lucide) need.push(loadScript(CDN.lucide).catch(() => {/* icons optional */}));
    _peersPromise = Promise.all(need);
    return _peersPromise;
  }

  let _babelPromise = null;
  function loadBabel() {
    if (window.Babel) return Promise.resolve();
    if (!_babelPromise) _babelPromise = loadScript(CDN.babel);
    return _babelPromise;
  }

  async function transpile(code) {
    if (!window.Sucrase) await loadScript(CDN.sucrase);
    try {
      return Sucrase.transform(code, { transforms: ['jsx'] }).code;
    } catch (sucraseErr) {
      // Sucrase couldn't parse — usually mid-stream JSX or exotic syntax.
      // Fall back to Babel which has a more forgiving parser.
      await loadBabel();
      return Babel.transform(code, { presets: ['react'], filename: 'artifact.jsx' }).code;
    }
  }

  // <Icon name="settings" size={20} className="text-blue-500" />
  // Resolves kebab-case names against window.lucide.icons (PascalCase keys).
  // Lucide v1+ stores each icon as just the children array:
  //   Plus = [['path', {d:'M5 12h14'}], ['path', {d:'M12 5v14'}]]
  // We wrap it in an <svg> with the standard Lucide default attributes.
  function toPascalCase(s) {
    return String(s).split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  }
  // lucide icon data uses kebab-case attr keys; React JSX expects camelCase.
  function attrsToCamel(attrs) {
    const out = {};
    for (const k in attrs) {
      const ck = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[ck] = attrs[k];
    }
    return out;
  }
  function makeIcon(React) {
    return function Icon({ name, size = 20, color = 'currentColor', strokeWidth = 2, className = '', style, ...rest }) {
      const placeholder = () => React.createElement('span', { className, style: { display: 'inline-block', width: size, height: size, ...style } });
      if (!window.lucide || !window.lucide.icons) return placeholder();
      const iconNode = window.lucide.icons[toPascalCase(name)] || window.lucide.icons[name];
      if (!iconNode || !Array.isArray(iconNode)) return placeholder();
      const svgProps = {
        xmlns: 'http://www.w3.org/2000/svg',
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className,
        style,
        ...rest,
      };
      const kids = iconNode.map(([childTag, childAttrs], i) =>
        React.createElement(childTag, { ...attrsToCamel(childAttrs || {}), key: i })
      );
      return React.createElement('svg', svgProps, kids);
    };
  }

  function buildComponent(transpiled) {
    const React = window.React;
    const { useState, useEffect, useRef, useMemo, useCallback,
            useReducer, useContext, createContext, Fragment, memo } = React;
    const Icon = makeIcon(React);
    const factory = new Function(
      'React', 'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback',
      'useReducer', 'useContext', 'createContext', 'Fragment', 'memo', 'Icon',
      transpiled + '\nreturn (typeof App !== "undefined") ? App : (typeof Main !== "undefined" ? Main : null);'
    );
    return factory(
      React, useState, useEffect, useRef, useMemo, useCallback,
      useReducer, useContext, createContext, Fragment, memo, Icon
    );
  }

  // One-shot mount — used by buildReactHtml() in standalone pages where the
  // shell's setCode/postMessage round-trip isn't needed. Streaming shells
  // call loadPeers + transpile + buildComponent directly with a render-token
  // guard for race protection.
  let _root = null;
  async function mountReact(rootEl, code) {
    await loadPeers();
    const transpiled = await transpile(code);
    const Comp = buildComponent(transpiled);
    if (!Comp) throw new Error('Define a top-level component named App.');
    if (!_root) _root = ReactDOM.createRoot(rootEl);
    _root.render(React.createElement(Comp));
    return Comp;
  }

  window.ArtifactRuntime = {
    loadScript,
    loadPeers,
    loadBabel,
    transpile,
    buildComponent,
    mountReact,
  };

  // Expose loadScript globally so user code (per the system prompt rule 9)
  // can call `await loadScript(url)` directly without an ArtifactRuntime prefix.
  if (typeof window.loadScript === 'undefined') window.loadScript = loadScript;
})();
