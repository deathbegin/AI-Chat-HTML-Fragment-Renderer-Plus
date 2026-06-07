// ==UserScript==
// @name         AI Chat HTML Fragment Renderer Plus
// @name:zh-CN   AI Chat HTML 片段渲染器 Plus（动态深浅色）
// @namespace    local.ai.chat-html-fragment-renderer-plus
// @version      2.5.5
// @description  Render marked HTML fragments in AI chat pages with live preview, dynamic light/dark theme adaptation, source toggle, script isolation, and PNG export.
// @description:zh-CN 在 AI Chat 网页中渲染带标记的 HTML 片段，支持实时预览、动态深浅色适配、源码切换、脚本隔离和 PNG 导出。
// @author       木子不是木子狸; ShrimpInTheSea
// @license      MIT
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @match        https://www.perplexity.ai/*
// @match        https://poe.com/*
// @match        https://copilot.microsoft.com/*
// @match        https://www.bing.com/chat*
// @match        https://chat.mistral.ai/*
// @match        https://chat.deepseek.com/*
// @match        https://kimi.moonshot.cn/*
// @match        https://kimi.com/*
// @match        https://www.kimi.com/*
// @match        https://www.doubao.com/*
// @match        https://yuanbao.tencent.com/*
// @match        https://chat.qwen.ai/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js
// @require      https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/580588/AI%20Chat%20HTML%20Fragment%20Renderer%20Plus.user.js
// @updateURL https://update.greasyfork.org/scripts/580588/AI%20Chat%20HTML%20Fragment%20Renderer%20Plus.meta.js
// ==/UserScript==

(() => {
  "use strict";

  // src/config.js
  const MARKER_START = "<!-- html-render-start -->";
  const MARKER_END = "<!-- html-render-end -->";
  const COMMENT_START = "html-render-start";
  const COMMENT_END = "html-render-end";

  const SCAN_DELAY_MS = 60;
  const LIVE_PREVIEW_MIN_CHARS = 6;
  const MAX_FRAGMENT_PROCESS_COUNT = 30;
  const PNG_SCALE = 2;
  const THEME_CHANGE_DELAY_MS = 120;
  const THEME_CHANGE_FOLLOWUP_MS = 360;
  const THEME_POLL_INTERVAL_MS = 1200;

  let scanTimer = null;
  let themeTimer = null;
  let themePollTimer = null;
  let blockSeq = 0;
  let observer = null;
  let themeObserver = null;
  let lastRendererThemeName = null;


  // src/theme-utils.js
  const RENDER_THEME_MODE = "auto"; // "auto" | "light" | "dark"
  const ADAPT_RENDERED_FRAGMENT_TO_PAGE_THEME = true;

  const BASIC_NAMED_COLORS = {
    black: { r: 0, g: 0, b: 0, a: 1 },
    white: { r: 255, g: 255, b: 255, a: 1 }
  };

  function parseRGBColor(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text || text === "transparent") return null;

    if (BASIC_NAMED_COLORS[text]) {
      return { ...BASIC_NAMED_COLORS[text] };
    }

    let match = text.match(/^rgba?\(([^)]+)\)$/i);
    if (match) {
      const parts = match[1]
        .split(/\s*,\s*|\s+\/\s+|\s+/)
        .map(item => item.trim())
        .filter(Boolean);

      if (parts.length >= 3) {
        const toChannel = raw => {
          if (String(raw).endsWith("%")) return Math.round(parseFloat(raw) * 2.55);
          return Number.parseFloat(raw);
        };

        const alpha = parts[3] == null ? 1 : Number.parseFloat(parts[3]);
        return {
          r: Math.max(0, Math.min(255, toChannel(parts[0]) || 0)),
          g: Math.max(0, Math.min(255, toChannel(parts[1]) || 0)),
          b: Math.max(0, Math.min(255, toChannel(parts[2]) || 0)),
          a: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1
        };
      }
    }

    match = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (match) {
      let hex = match[1];
      if (hex.length === 3) hex = hex.split("").map(ch => ch + ch).join("");
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1
      };
    }

    return null;
  }

  function relativeLuminance(color) {
    if (!color) return 1;

    const convert = channel => {
      const value = channel / 255;
      return value <= 0.03928
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    };

    return 0.2126 * convert(color.r) + 0.7152 * convert(color.g) + 0.0722 * convert(color.b);
  }

  function isLikelyDarkColor(value) {
    const color = parseRGBColor(value);
    return Boolean(color && color.a > 0.08 && relativeLuminance(color) < 0.36);
  }

  function getOpaqueBackgroundColor() {
    const nodes = [document.body, document.documentElement].filter(Boolean);

    for (const node of nodes) {
      const color = window.getComputedStyle(node).backgroundColor;
      const parsed = parseRGBColor(color);
      if (parsed && parsed.a > 0.08) return color;
    }

    return "rgb(255,255,255)";
  }

  function isPageDarkMode() {
    if (RENDER_THEME_MODE === "dark") return true;
    if (RENDER_THEME_MODE === "light") return false;

    const bg = getOpaqueBackgroundColor();
    if (isLikelyDarkColor(bg)) return true;

    const htmlStyle = window.getComputedStyle(document.documentElement);
    const bodyStyle = document.body ? window.getComputedStyle(document.body) : htmlStyle;
    const colorScheme = `${htmlStyle.colorScheme || ""} ${bodyStyle.colorScheme || ""}`.trim().toLowerCase();
    if (/\bdark\b/.test(colorScheme) && !/^light\b/.test(colorScheme)) return true;

    try {
      return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches || false;
    } catch {
      return false;
    }
  }

  function getRendererTheme() {
    if (isPageDarkMode()) {
      return {
        name: "dark",
        surface: "#18181b",
        surfaceRaised: "#202024",
        surfaceSoft: "rgba(255,255,255,.06)",
        surfaceSofter: "rgba(255,255,255,.035)",
        text: "rgba(244,244,245,.86)",
        textStrong: "#f4f4f5",
        textMuted: "rgba(244,244,245,.62)",
        textFaint: "rgba(244,244,245,.46)",
        border: "rgba(255,255,255,.14)",
        borderStrong: "rgba(255,255,255,.22)",
        inverseSurface: "#f4f4f5",
        inverseText: "#111827",
        shadow: "rgba(0,0,0,.38)"
      };
    }

    return {
      name: "light",
      surface: "#fff",
      surfaceRaised: "#fff",
      surfaceSoft: "rgba(0,0,0,.04)",
      surfaceSofter: "rgba(0,0,0,.025)",
      text: "rgba(0,0,0,.72)",
      textStrong: "#111",
      textMuted: "rgba(0,0,0,.55)",
      textFaint: "rgba(0,0,0,.45)",
      border: "rgba(0,0,0,.14)",
      borderStrong: "rgba(0,0,0,.22)",
      inverseSurface: "#111",
      inverseText: "#fff",
      shadow: "rgba(0,0,0,.16)"
    };
  }

  function withAlpha(color, alpha) {
    const parsed = parseRGBColor(color);
    if (!parsed) return color;
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return `rgba(${Math.round(parsed.r)},${Math.round(parsed.g)},${Math.round(parsed.b)},${a})`;
  }

  function blendColorOverBackground(fg, bg) {
    if (!fg) return bg;
    if (!bg) return fg;

    const alpha = fg.a == null ? 1 : fg.a;
    if (alpha >= 0.999) return { ...fg, a: 1 };

    return {
      r: fg.r * alpha + bg.r * (1 - alpha),
      g: fg.g * alpha + bg.g * (1 - alpha),
      b: fg.b * alpha + bg.b * (1 - alpha),
      a: 1
    };
  }

  function getContrastRatio(a, b) {
    const lumA = relativeLuminance(a);
    const lumB = relativeLuminance(b);
    const lighter = Math.max(lumA, lumB);
    const darker = Math.min(lumA, lumB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function getEffectiveBackgroundColor(el, fallbackColor) {
    let node = el;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      try {
        const bg = parseRGBColor(window.getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0.02) {
          const fallback = parseRGBColor(fallbackColor) || { r: 255, g: 255, b: 255, a: 1 };
          return blendColorOverBackground(bg, fallback);
        }
      } catch {
        // Ignore unreadable computed style.
      }

      node = node.parentElement;
    }

    return parseRGBColor(fallbackColor) || { r: 255, g: 255, b: 255, a: 1 };
  }

  function getColorTokenRegex() {
    return /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b|rgba?\((?:[^)(]|\([^)]*\))*\)|\b(?:black|white)\b/gi;
  }

  function getColorSaturation(color) {
    if (!color) return 0;

    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;

    if (max === min) return 0;
    return (max - min) / (1 - Math.abs(2 * lightness - 1));
  }

  function isGrayscaleColor(color) {
    if (!color) return false;
    return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 8;
  }

  function isNeutralLikeColor(color) {
    if (!color) return false;
    if (isGrayscaleColor(color)) return true;

    const lum = relativeLuminance(color);
    const saturation = getColorSaturation(color);

    // Covers slate-like dark UI text such as #0f172a / #111827 / #1f2937,
    // while preserving highly saturated accent colors like blue, red, green.
    return (
      (lum < 0.26 && saturation <= 0.76) ||
      (lum < 0.42 && saturation <= 0.48) ||
      (lum > 0.82 && saturation <= 0.38)
    );
  }

  function getStyleColorRole(prop) {
    const p = String(prop || "").toLowerCase();

    if (
      p.includes("background") ||
      p === "accent-color" ||
      p === "scrollbar-color"
    ) return "background";

    if (
      p === "color" ||
      p === "caret-color" ||
      p.includes("text-emphasis")
    ) return "text";

    if (
      p.includes("border") ||
      p.includes("outline") ||
      p.includes("decoration") ||
      p.includes("column-rule") ||
      p === "stroke"
    ) return "border";

    if (p === "fill") return "fill";
    if (p.includes("shadow")) return "shadow";
    return "other";
  }

  function mapGrayColorForDarkMode(prop, color) {
    const theme = getRendererTheme();
    const role = getStyleColorRole(prop);
    const lum = relativeLuminance(color);
    const alpha = color.a == null ? 1 : color.a;

    if (alpha <= 0.001) return "transparent";

    if (role === "background") {
      if (lum > 0.88) return theme.surface;
      if (lum < 0.12 && alpha >= 0.85) return theme.inverseSurface;
      if (lum < 0.25) return withAlpha(theme.textStrong, Math.min(0.20, Math.max(alpha, alpha * 1.5)));
      return withAlpha(theme.textStrong, Math.min(0.16, Math.max(0.04, alpha * 0.8)));
    }

    if (role === "text" || role === "fill") {
      if (lum > 0.88 && alpha >= 0.85) return theme.inverseText;
      if (lum < 0.22) return withAlpha(theme.textStrong, Math.max(alpha, 0.72));
      return withAlpha(theme.textStrong, Math.max(alpha, 0.58));
    }

    if (role === "border") {
      if (lum > 0.88 && alpha >= 0.85) return theme.borderStrong;
      return withAlpha(theme.textStrong, Math.min(0.34, Math.max(alpha, 0.14)));
    }

    if (role === "shadow") {
      return `rgba(0,0,0,${Math.min(0.55, Math.max(alpha, 0.22))})`;
    }

    if (lum > 0.88 && alpha >= 0.85) return theme.surface;
    if (lum < 0.22) return withAlpha(theme.textStrong, Math.max(alpha, 0.60));
    return withAlpha(theme.textStrong, alpha);
  }

  function shouldAdaptColorForDarkMode(prop, color) {
    if (!color) return false;

    const role = getStyleColorRole(prop);
    const lum = relativeLuminance(color);
    const saturation = getColorSaturation(color);

    if (isNeutralLikeColor(color)) return true;

    if (role === "text" || role === "fill") {
      return (
        (lum < 0.28 && saturation <= 0.78) ||
        (lum < 0.44 && saturation <= 0.52) ||
        (lum > 0.90 && saturation <= 0.45)
      );
    }

    if (role === "background") {
      return (
        lum > 0.84 ||
        (lum < 0.16 && saturation <= 0.72) ||
        saturation <= 0.30
      );
    }

    if (role === "border" || role === "shadow") {
      return lum > 0.72 || lum < 0.34 || saturation <= 0.42;
    }

    return false;
  }

  function adaptColorTokenForDarkMode(prop, token) {
    if (!isPageDarkMode()) return token;

    const color = parseRGBColor(token);
    if (!color || !shouldAdaptColorForDarkMode(prop, color)) return token;
    return mapGrayColorForDarkMode(prop, color);
  }

  function adaptStyleValueForDarkMode(prop, value) {
    let output = String(value || "");

    output = output.replace(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi, token => {
      return adaptColorTokenForDarkMode(prop, token);
    });

    output = output.replace(/rgba?\((?:[^)(]|\([^)]*\))*\)/gi, token => {
      return adaptColorTokenForDarkMode(prop, token);
    });

    output = output.replace(/\b(?:black|white)\b/gi, token => {
      return adaptColorTokenForDarkMode(prop, token);
    });

    return output;
  }

  function adaptInlineStyleForDarkMode(styleText) {
    return String(styleText || "")
      .split(";")
      .map(part => {
        const index = part.indexOf(":");
        if (index === -1) return part;

        const prop = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!prop || !value || prop.startsWith("--")) return part;

        return `${prop}: ${adaptStyleValueForDarkMode(prop, value)}`;
      })
      .join("; ");
  }

  function hasInlineStyleProperty(el, prop) {
    const styleText = String(el?.getAttribute?.("style") || "");
    const safeProp = String(prop || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|;)\\s*${safeProp}\\s*:`, "i").test(styleText);
  }


  function getLastInlineColor(styleText, propPattern) {
    const parts = String(styleText || "").split(";");
    let result = null;

    for (const part of parts) {
      const index = part.indexOf(":");
      if (index === -1) continue;

      const prop = part.slice(0, index).trim().toLowerCase();
      const value = part.slice(index + 1).trim();
      if (!propPattern.test(prop)) continue;

      const matches = value.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b|rgba?\((?:[^)(]|\([^)]*\))*\)|\b(?:black|white)\b/gi);
      if (matches?.length) result = matches.at(-1);
    }

    return result;
  }

  function pickDefaultTextColorForElement(el, theme = getRendererTheme()) {
    const bgToken = getLastInlineColor(el?.getAttribute?.("style") || "", /^(background|background-color)$/i);
    const bg = parseRGBColor(bgToken);

    if (bg && bg.a > 0.65 && relativeLuminance(bg) > 0.62) {
      return theme.inverseText;
    }

    return theme.text;
  }

  function stabilizeImplicitTextColorsForDarkMode(container) {
    if (!isPageDarkMode() || !container) return;

    const theme = getRendererTheme();
    const textTags = /^(DIV|P|SPAN|STRONG|EM|SMALL|CODE|PRE|TH|TD|SUMMARY|BUTTON|LI|LABEL|H[1-6])$/i;
    const skipTags = /^(SCRIPT|STYLE|SVG|PATH|G|RECT|CIRCLE|LINE|POLYLINE|POLYGON|IMG|VIDEO|AUDIO|CANVAS|INPUT|TEXTAREA|SELECT|OPTION)$/i;
    const elements = [container, ...Array.from(container.querySelectorAll("*"))];

    for (const el of elements) {
      if (!el.style || skipTags.test(el.tagName || "")) continue;
      if (hasInlineStyleProperty(el, "color")) continue;
      if (!textTags.test(el.tagName || "")) continue;

      el.style.setProperty("color", pickDefaultTextColorForElement(el, theme));
    }
  }

  function hasRenderableOwnText(el) {
    return Array.from(el?.childNodes || []).some(node => {
      return node.nodeType === Node.TEXT_NODE && Boolean((node.nodeValue || "").trim());
    });
  }

  function shouldRepairComputedTextColor(color) {
    if (!color || color.a <= 0.08) return false;

    const lum = relativeLuminance(color);
    const saturation = getColorSaturation(color);

    return (
      lum < 0.38 ||
      (lum < 0.48 && saturation <= 0.55)
    );
  }

  function repairComputedTextContrastForDarkMode(container) {
    if (!isPageDarkMode() || !container?.isConnected) return;

    const theme = getRendererTheme();
    const textTags = /^(DIV|P|SPAN|STRONG|EM|SMALL|CODE|PRE|TH|TD|SUMMARY|BUTTON|LI|LABEL|H[1-6])$/i;
    const skipTags = /^(SCRIPT|STYLE|SVG|PATH|G|RECT|CIRCLE|LINE|POLYLINE|POLYGON|IMG|VIDEO|AUDIO|CANVAS|INPUT|TEXTAREA|SELECT|OPTION)$/i;
    const elements = [container, ...Array.from(container.querySelectorAll("*"))];

    for (const el of elements) {
      if (!el.style || skipTags.test(el.tagName || "") || !textTags.test(el.tagName || "")) continue;
      if (!hasRenderableOwnText(el) && !/^(CODE|PRE|BUTTON|TH|TD|SUMMARY|H[1-6])$/i.test(el.tagName || "")) continue;

      try {
        const computed = window.getComputedStyle(el);
        const color = parseRGBColor(computed.color);
        if (shouldRepairComputedTextColor(color)) {
          const tag = String(el.tagName || "").toUpperCase();
          el.style.setProperty("color", tag === "DIV" || tag === "SPAN" || tag === "P" ? theme.text : theme.textStrong);
        }
      } catch {
        // Ignore unreadable computed style.
      }
    }
  }

  function shouldRepairComputedTextColorForLightMode(color, background) {
    if (!color || !background || color.a <= 0.08) return false;

    const effectiveColor = blendColorOverBackground(color, background);
    const textLum = relativeLuminance(effectiveColor);
    const bgLum = relativeLuminance(background);
    const contrast = getContrastRatio(effectiveColor, background);
    const saturation = getColorSaturation(effectiveColor);

    return (
      bgLum > 0.50 &&
      contrast < 3.2 &&
      (
        textLum > 0.58 ||
        (textLum > 0.48 && saturation <= 0.48)
      )
    );
  }

  function repairComputedTextContrastForLightMode(container) {
    if (isPageDarkMode() || !container?.isConnected) return;

    const theme = getRendererTheme();
    const pageBg = getOpaqueBackgroundColor();
    const textTags = /^(DIV|P|SPAN|STRONG|EM|SMALL|CODE|PRE|TH|TD|SUMMARY|BUTTON|LI|LABEL|H[1-6])$/i;
    const skipTags = /^(SCRIPT|STYLE|SVG|PATH|G|RECT|CIRCLE|LINE|POLYLINE|POLYGON|IMG|VIDEO|AUDIO|CANVAS|INPUT|TEXTAREA|SELECT|OPTION)$/i;
    const elements = [container, ...Array.from(container.querySelectorAll("*"))];

    for (const el of elements) {
      if (!el.style || skipTags.test(el.tagName || "") || !textTags.test(el.tagName || "")) continue;
      if (!hasRenderableOwnText(el) && !/^(CODE|PRE|BUTTON|TH|TD|SUMMARY|H[1-6])$/i.test(el.tagName || "")) continue;

      try {
        const computed = window.getComputedStyle(el);
        const color = parseRGBColor(computed.color);
        const background = getEffectiveBackgroundColor(el, pageBg);

        if (shouldRepairComputedTextColorForLightMode(color, background)) {
          const tag = String(el.tagName || "").toUpperCase();
          el.style.setProperty("color", /^(H[1-6]|STRONG|B|CODE|PRE|TH|BUTTON|SUMMARY)$/i.test(tag) ? theme.textStrong : theme.text);
        }
      } catch {
        // Ignore unreadable computed style.
      }
    }
  }

  function stabilizeCodeElementsForDarkMode(container) {
    if (!isPageDarkMode() || !container?.isConnected) return;

    const theme = getRendererTheme();

    container.querySelectorAll("code").forEach(code => {
      if (!code.style) return;

      if (!hasInlineStyleProperty(code, "background") && !hasInlineStyleProperty(code, "background-color")) {
        code.style.setProperty("background", theme.surfaceSoft);
      }

      if (!hasInlineStyleProperty(code, "color")) {
        code.style.setProperty("color", theme.textStrong);
      }

      if (!hasInlineStyleProperty(code, "border")) {
        code.style.setProperty("border", `1px solid ${theme.border}`);
      }

      if (!hasInlineStyleProperty(code, "border-radius")) {
        code.style.setProperty("border-radius", "4px");
      }

      if (!hasInlineStyleProperty(code, "padding")) {
        code.style.setProperty("padding", "0.08em 0.32em");
      }
    });
  }

  function queuePostRenderThemeRepair(container) {
    if (!container) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (isPageDarkMode()) {
          repairComputedTextContrastForDarkMode(container);
          stabilizeCodeElementsForDarkMode(container);
        } else {
          repairComputedTextContrastForLightMode(container);
        }
      });
    });
  }

  const RENDERER_SELECTION_STYLE_ID = "ai-raw-html-fragment-renderer-selection-contrast-css";

  function ensureRendererSelectionStyles() {
    if (document.getElementById(RENDERER_SELECTION_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = RENDERER_SELECTION_STYLE_ID;
    style.textContent = `
[data-html-rendered-block='1'] [data-html-render-content='1'] ::selection,
[data-html-render-live-preview='1'] [data-html-render-live-content='1'] ::selection {
  background: rgba(96, 165, 250, .42) !important;
  color: #ffffff !important;
  text-shadow: none !important;
}
[data-html-rendered-block='1'] [data-html-render-content='1'] *::selection,
[data-html-render-live-preview='1'] [data-html-render-live-content='1'] *::selection {
  background: rgba(96, 165, 250, .42) !important;
  color: #ffffff !important;
  text-shadow: none !important;
}`.trim();

    (document.head || document.documentElement).appendChild(style);
  }

  function adaptRenderedFragmentToTheme(container) {
    if (!ADAPT_RENDERED_FRAGMENT_TO_PAGE_THEME || !isPageDarkMode() || !container) return;

    const elements = [container, ...Array.from(container.querySelectorAll("*"))];

    for (const el of elements) {
      if (!el.style) continue;

      const styleText = el.getAttribute("style");
      if (!styleText || !/(#(?:[0-9a-f]{3}|[0-9a-f]{6})\b|rgba?\(|\b(?:black|white)\b)/i.test(styleText)) continue;

      el.setAttribute("style", adaptInlineStyleForDarkMode(styleText));
    }

    stabilizeImplicitTextColorsForDarkMode(container);
  }

  function getSmallButtonStyle(theme = getRendererTheme()) {
    return [
      `border: 1px solid ${theme.borderStrong}`,
      "border-radius: 7px",
      `background: ${theme.surfaceRaised}`,
      "padding: 2px 8px",
      "font-size: 12px",
      "line-height: 1.4",
      "cursor: pointer",
      `color: ${theme.text}`
    ].join("; ");
  }

  function applySmallButtonTheme(button, theme = getRendererTheme()) {
    if (!button) return;
    button.style.cssText = getSmallButtonStyle(theme);
  }

  function getToolbarStyle(theme = getRendererTheme()) {
    return [
      "display: flex",
      "justify-content: space-between",
      "align-items: center",
      "gap: 8px",
      "margin-bottom: 6px",
      "font-size: 12px",
      "line-height: 1.4",
      `color: ${theme.textMuted}`
    ].join("; ");
  }

  function applyToolbarTheme(toolbar, theme = getRendererTheme()) {
    if (!toolbar) return;
    toolbar.style.cssText = getToolbarStyle(theme);
  }

  function getSourceBlockStyle(theme = getRendererTheme(), display = "none") {
    return [
      `display: ${display}`,
      "white-space: pre-wrap",
      "word-break: break-word",
      "margin: 0",
      "padding: 10px",
      `border: 1px solid ${theme.border}`,
      "border-radius: 8px",
      `background: ${theme.surfaceSoft}`,
      `color: ${theme.text}`,
      "font-size: 12px",
      "line-height: 1.5",
      "overflow-x: auto"
    ].join("; ");
  }

  function applySourceBlockTheme(source, theme = getRendererTheme()) {
    if (!source) return;
    const display = source.style.display || source.getAttribute("data-html-render-source-display") || "none";
    source.style.cssText = getSourceBlockStyle(theme, display);
  }

  function getFallbackBlockStyle(theme = getRendererTheme()) {
    return [
      "white-space: pre-wrap",
      "word-break: break-word",
      "margin: 12px 0",
      "padding: 10px",
      `border: 1px solid ${theme.border}`,
      "border-radius: 8px",
      `background: ${theme.surfaceSoft}`,
      `color: ${theme.text}`,
      "font-size: 12px",
      "line-height: 1.5",
      "overflow-x: auto"
    ].join("; ");
  }

  function applyFallbackBlockTheme(pre, theme = getRendererTheme()) {
    if (!pre) return;
    pre.style.cssText = getFallbackBlockStyle(theme);
  }

  function applyPromptInjectorTheme(button, theme = getRendererTheme()) {
    if (!button) return;
    button.style.cssText = [
      getSmallButtonStyle(theme),
      "position: fixed",
      "right: 18px",
      "bottom: 18px",
      "z-index: 2147483646",
      `box-shadow: 0 8px 24px ${theme.shadow}`,
      "padding: 8px 11px",
      "font-size: 13px",
      `background: ${theme.inverseSurface}`,
      `color: ${theme.inverseText}`,
      `border-color: ${theme.name === "dark" ? "rgba(0,0,0,.22)" : "rgba(255,255,255,.18)"}`
    ].join("; ");
  }

  function applyLiveHintTheme(hint, theme = getRendererTheme()) {
    if (!hint) return;
    hint.style.cssText = [
      "margin-top: 6px",
      "font-size: 12px",
      "line-height: 1.4",
      `color: ${theme.textFaint}`
    ].join("; ");
  }

  function renderRawHTMLIntoContainer(container, rawHTML) {
    if (!container) return;

    container.replaceChildren();
    container.appendChild(parseRawHTML(rawHTML));
    adaptRenderedFragmentToTheme(container);
    renderLatexInElement(container);
    queuePostRenderThemeRepair(container);
  }

  function activateRenderedContainer(container) {
    if (!container) return;

    requestAnimationFrame(() => {
      executeScripts(container);

      requestAnimationFrame(() => {
        dispatchReadyEvent(container);
      });
    });
  }

  function refreshPluginChromeForTheme() {
    const theme = getRendererTheme();

    document.querySelectorAll("[data-html-render-toolbar='1']").forEach(el => applyToolbarTheme(el, theme));
    document.querySelectorAll("[data-html-render-small-button='1']").forEach(el => applySmallButtonTheme(el, theme));
    document.querySelectorAll("[data-html-render-source='1']").forEach(el => applySourceBlockTheme(el, theme));
    document.querySelectorAll("[data-html-render-fallback='1']").forEach(el => applyFallbackBlockTheme(el, theme));
    document.querySelectorAll("[data-html-render-live-hint='1']").forEach(el => applyLiveHintTheme(el, theme));
    document.querySelectorAll("[data-html-render-prompt-injector='1']").forEach(el => applyPromptInjectorTheme(el, theme));
  }

  function getOriginalRawHTMLForBlock(block) {
    if (!block) return "";

    if (typeof block.__htmlRenderOriginalRawHTML === "string") {
      return block.__htmlRenderOriginalRawHTML;
    }

    const source = block.querySelector("[data-html-render-source='1']");
    const rawHTML = source?.textContent || "";
    block.__htmlRenderOriginalRawHTML = rawHTML;
    return rawHTML;
  }

  function rerenderBlockForTheme(block) {
    if (!block) return;

    const theme = getRendererTheme();
    const rendered = block.querySelector("[data-html-render-content='1']");
    const source = block.querySelector("[data-html-render-source='1']");
    if (!rendered || !source) return;

    const renderedDisplay = rendered.style.display || "block";
    const rawHTML = getOriginalRawHTMLForBlock(block);

    if (source.textContent !== rawHTML) {
      source.textContent = rawHTML;
    }

    block.setAttribute("data-html-render-theme", theme.name);
    renderRawHTMLIntoContainer(rendered, rawHTML);
    rendered.style.display = renderedDisplay;
    activateRenderedContainer(rendered);
  }

  function rerenderLivePreviewForTheme(block) {
    if (!block) return;

    const rawHTML = block.__htmlRenderRawHTML;
    if (!rawHTML) return;

    block.setAttribute("data-html-render-theme", getRendererTheme().name);
    updateLivePreviewBlock(block, rawHTML);
  }

  function refreshRenderedBlocksForTheme() {
    document.querySelectorAll("[data-html-rendered-block='1']").forEach(rerenderBlockForTheme);
    document.querySelectorAll("[data-html-render-live-preview='1']").forEach(rerenderLivePreviewForTheme);
  }

  function applyRendererThemeRefresh(force = false) {
    const theme = getRendererTheme();

    if (!force && lastRendererThemeName === theme.name) return;
    lastRendererThemeName = theme.name;

    refreshPluginChromeForTheme();
    refreshRenderedBlocksForTheme();
    scheduleScan();
  }

  function scheduleRendererThemeRefresh(force = false) {
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => applyRendererThemeRefresh(force), THEME_CHANGE_DELAY_MS);
  }

  function initThemeWatcher() {
    lastRendererThemeName = getRendererTheme().name;

    const onPossibleThemeChange = () => {
      scheduleRendererThemeRefresh(false);

      // Many AI chat UIs switch theme in phases: class changes first, then CSS variables,
      // then message containers repaint. Multiple follow-ups prevent mixed light/dark states.
      [THEME_CHANGE_FOLLOWUP_MS, 900, 1800].forEach(delay => {
        setTimeout(() => scheduleRendererThemeRefresh(false), delay);
      });
    };

    const attributeFilter = [
      "class",
      "style",
      "color-scheme",
      "data-theme",
      "data-color-mode",
      "data-color-scheme",
      "data-mode",
      "data-bs-theme"
    ];

    themeObserver = new MutationObserver(onPossibleThemeChange);

    [document.documentElement, document.body].filter(Boolean).forEach(node => {
      themeObserver.observe(node, {
        attributes: true,
        attributeFilter
      });
    });

    try {
      const media = window.matchMedia?.("(prefers-color-scheme: dark)");
      if (media?.addEventListener) {
        media.addEventListener("change", onPossibleThemeChange);
      } else if (media?.addListener) {
        media.addListener(onPossibleThemeChange);
      }
    } catch {
      // Ignore unsupported matchMedia environments.
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleRendererThemeRefresh(false);
    });

    themePollTimer = setInterval(() => scheduleRendererThemeRefresh(false), THEME_POLL_INTERVAL_MS);
  }

  // src/prompt-preset.js
  const HTML_VISUAL_PROMPT_TITLE = "HTML 可视化输出规范";

  const HTML_VISUAL_PROMPT = `<!-- HTML 可视化输出规范 -->
  <format>
    <language>使用简体中文。</language>

    <markdown-rules>
      <rule>标题从 ## 起，子层级使用 ###；禁止使用单个 # 作为标题。</rule>
      <rule>保持高信息密度，避免松散寒暄、重复铺垫和低价值过渡句。</rule>
      <rule>优先使用短段落、紧凑列表、局部表格或局部 HTML 可视化组织信息。</rule>
      <rule>代码块必须标注语言；代码优先完整可运行；复杂逻辑必须添加必要注释。</rule>
      <rule>普通解释仍使用 Markdown；不要为了形式化而滥用 HTML。</rule>
    </markdown-rules>

    <html-renderer-compatibility>
      <core-rule>需要输出可视化 HTML 片段时，必须用 <!-- html-render-start --> 和 <!-- html-render-end --> 包裹。</core-rule>
      <boundary-rule>HTML 只能是局部片段，禁止输出 <!DOCTYPE html>、html、head、body 或完整页面框架。</boundary-rule>
      <streaming-rule>片段必须允许流式预览；交互在闭合 marker 后由本地渲染器自动绑定。</streaming-rule>
      <placement-rule>HTML 片段必须自然嵌入正文流中，禁止把整篇回答包进一个巨大 HTML 块。</placement-rule>
      <single-fragment-rule>每个 HTML 片段只表达一个明确的信息单元；复杂内容拆成多个小片段。</single-fragment-rule>
      <interaction-rule>交互必须使用名称绑定的声明式协议：组件根节点使用唯一 data-html-interaction-id，数据脚本使用同名 data-html-interaction-for。</interaction-rule>
      <interaction-binding-rule>按钮使用 data-step；可更新文本槽位使用 data-role="title" 和 data-role="desc"；data-step 的值必须存在于同名 JSON 的 steps 中。</interaction-binding-rule>
      <interaction-isolation-rule>同一片段内多个交互组件必须使用不同 data-html-interaction-id；组件只能读取同名 JSON，只能更新自身根节点内部的 data-role 槽位。</interaction-isolation-rule>
      <script-rule>禁止输出可执行 JavaScript；script 只能用于 type="application/json" 的交互数据声明。</script-rule>
      <script-scope-rule>交互只能作用于当前 data-html-interaction-id 组件内部元素，禁止宽泛选择器污染页面。</script-scope-rule>
      <no-heavy-script>禁止高频定时器、无限循环、大量 DOM 监听器、自动网络请求、自动下载、自动跳转、弹窗轰炸。</no-heavy-script>
    </html-renderer-compatibility>

    <html-visual>
      <rationale>当纯 Markdown 无法清晰紧凑地表达复杂逻辑、对比、流程、结构或信息卡片时，应主动使用局部 HTML 可视化。</rationale>
      <default-trigger>
        <case type="logic-graph">流程图、架构图、状态机、树状层级、因果链、决策树优先用 HTML/CSS 表达。</case>
        <case type="horizontal-layout">多方案对比、优劣势对照、参数矩阵、角色分工、并排时间线优先用 Flexbox。</case>
        <case type="info-card">摘要卡、风险卡、步骤卡、配置卡、诊断卡优先用边框、留白、字号层级和灰度背景组织。</case>
        <case type="space-optimize">内容较多时可使用 details/summary、分组卡片、紧凑网格收拢信息。</case>
        <case type="interactive">需要轻量交互时使用 data-html-interaction-id + data-step + 同名 JSON，交互必须服务信息理解。</case>
      </default-trigger>
      <style-system>
        <rule>默认黑白灰主色调，用线条、留白、边框、字号和灰度层级建立结构。</rule>
        <rule>强调色必须克制，只用于重点、状态或风险等级。</rule>
        <rule>视觉目标是信息密度高、层级清楚、阅读阻力低。</rule>
        <rule>同时适配浅色和深色背景；避免依赖纯白底、纯黑字导致低对比度。</rule>
      </style-system>
      <css-constraint>
        <rule>禁止 style 标签、class 属性、伪类和伪元素。</rule>
        <rule>所有样式必须 100% 使用内联 style。</rule>
        <rule>布局优先使用 Flexbox 与基础盒模型。</rule>
        <rule>除非明确启用 Vision+，默认不要使用复杂 CSS 特效、动画、大型 SVG 或 Canvas。</rule>
      </css-constraint>
      <html-allowed>div, span, p, strong, em, small, code, pre, details, summary, button, input, textarea, select, option, table, thead, tbody, tr, th, td, svg, script type="application/json"</html-allowed>
      <html-forbidden>html, head, body, style, iframe, object, embed, link, meta, base, form</html-forbidden>
      <security-boundary>
        <rule>禁止读取 cookie/localStorage/sessionStorage、监听账号信息、截获输入内容或修改主页面 UI。</rule>
        <rule>禁止自动网络请求，除非用户明确要求且目的安全。</rule>
        <rule>禁止隐藏式下载、自动跳转、自动复制、自动提交表单。</rule>
        <rule>交互只能操作当前 HTML 片段内部 DOM。</rule>
      </security-boundary>
    </html-visual>

    <vision-plus>
      <activation>仅当用户显式声明“启用 Vision+”“使用更强 HTML 可视化”“需要复杂图形/图表/交互”时启用。</activation>
      <capability>可用内联 HTML/SVG 绘制流程图、架构图、状态机、树状层级、对比矩阵、轻量数据图表、几何说明图。</capability>
      <red-line>
        <rule>HTML 片段必须服务具体信息表达，禁止喧宾夺主、装饰性插画或完整页面框架。</rule>
        <rule>不要把整段回复全量包裹于单一 HTML 块。</rule>
        <rule>必须优先保证稳定、简洁、可读，权衡 Token 成本和渲染稳定性。</rule>
      </red-line>
    </vision-plus>

    <output-decision>
      <rule>简单事实、短解释、普通步骤：使用 Markdown。</rule>
      <rule>中等复杂内容：Markdown + 一个局部 HTML 信息卡或对比块。</rule>
      <rule>复杂结构内容：Markdown 解释 + 多个小型 HTML 可视化片段。</rule>
      <rule>代码交付：代码用 Markdown 代码块；架构图、模块关系图、参数矩阵才使用 HTML 可视化。</rule>
    </output-decision>

    <html-template>
      <rule>每个 HTML 片段必须采用如下结构：</rule>
    </html-template>
  </format>

  <example>
  <!-- html-render-start -->
  <div data-html-fragment-id="frag-example-001" style="margin:12px 0;padding:14px;border:1px solid rgba(0,0,0,.16);border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.04);font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;">
      <div>
        <div style="font-size:15px;font-weight:700;line-height:1.35;color:#111;">局部 HTML 可视化标题</div>
        <div style="font-size:12px;line-height:1.45;color:rgba(0,0,0,.58);margin-top:3px;">用于表达一个明确的信息单元，不包裹整篇回答。</div>
      </div>
      <div style="font-size:11px;line-height:1.3;padding:3px 7px;border:1px solid rgba(0,0,0,.14);border-radius:999px;color:rgba(0,0,0,.62);background:rgba(0,0,0,.03);white-space:nowrap;">HTML 片段</div>
    </div>
    <div style="display:flex;gap:8px;align-items:stretch;">
      <div style="flex:1;padding:10px;border:1px solid rgba(0,0,0,.12);border-radius:10px;background:rgba(0,0,0,.025);">
        <div style="font-size:12px;font-weight:700;color:#111;margin-bottom:4px;">模块 A</div>
        <div style="font-size:12px;line-height:1.5;color:rgba(0,0,0,.68);">负责输入、归纳和结构化。</div>
      </div>
      <div style="display:flex;align-items:center;color:rgba(0,0,0,.42);font-size:18px;">→</div>
      <div style="flex:1;padding:10px;border:1px solid rgba(0,0,0,.12);border-radius:10px;background:rgba(0,0,0,.025);">
        <div style="font-size:12px;font-weight:700;color:#111;margin-bottom:4px;">模块 B</div>
        <div style="font-size:12px;line-height:1.5;color:rgba(0,0,0,.68);">负责渲染、对比和输出。</div>
      </div>
    </div>
  </div>
  <!-- html-render-end -->
  </example>

  <interactive-example>
  <!-- html-render-start -->
  <div data-html-fragment-id="frag-interactive-example-001" data-html-interaction-id="method-flow-001" style="margin:12px 0;padding:14px;border:1px solid rgba(0,0,0,.16);border-radius:12px;background:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
      <button data-step="claim" style="cursor:pointer;border:1px solid rgba(0,0,0,.2);border-radius:999px;background:#111;color:#fff;padding:7px 10px;font-size:12px;">1. 提出断言</button>
      <button data-step="question" style="cursor:pointer;border:1px solid rgba(0,0,0,.2);border-radius:999px;background:#fff;color:#111;padding:7px 10px;font-size:12px;">2. 连续追问</button>
    </div>
    <div data-role="title" style="font-size:14px;font-weight:800;color:#111;margin-bottom:6px;">提出断言</div>
    <div data-role="desc" style="font-size:13px;line-height:1.55;color:rgba(0,0,0,.7);">先把模糊直觉变成可检验的命题。</div>
    <script type="application/json" data-html-interaction-for="method-flow-001">
      {
        "type": "step-detail",
        "steps": {
          "claim": {
            "title": "提出断言",
            "desc": "先把模糊直觉变成可检验的命题。"
          },
          "question": {
            "title": "连续追问",
            "desc": "通过更具体的场景压缩概念空间，暴露定义边界。"
          }
        }
      }
    </script>
  </div>
  <!-- html-render-end -->
  </interactive-example>

  <require>
    <rule>更积极地使用 html-visual 改善复杂回答质量，但不得滥用。</rule>
    <rule>默认黑白灰为主，用线条、留白、边框、字号层级建立设计感；深色页面中应保持背景、边框、文字的足够对比。</rule>
    <rule>彩色只用于重点强调、状态提示或风险等级，且必须克制。</rule>
    <rule>所有 HTML 必须兼容局部渲染脚本：有 start/end marker，是局部片段，使用内联样式。</rule>
    <rule>流式阶段不需要交互；闭合 marker 后本地渲染器按 data-html-interaction-id 绑定交互。</rule>
  </require>`;

  // src/dom-utils.js
  function decodeHTMLEntities(text) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text || "";
    return textarea.value;
  }

  function normalizeText(text) {
    return decodeHTMLEntities(text || "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ");
  }

  function parseRawHTML(rawHTML) {
    const html = decodeHTMLEntities(String(rawHTML || "").trim());
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content.cloneNode(true);
  }

  const KATEX_STYLE_ID = "ai-raw-html-fragment-renderer-katex-css";
  const KATEX_STYLE_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css";
  let didWarnMissingKatex = false;

  function ensureKatexStylesheet() {
    if (document.getElementById(KATEX_STYLE_ID)) return;

    const link = document.createElement("link");
    link.id = KATEX_STYLE_ID;
    link.rel = "stylesheet";
    link.href = KATEX_STYLE_URL;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }

  function renderLatexInElement(container) {
    if (!container || typeof window.renderMathInElement !== "function") {
      if (!didWarnMissingKatex) {
        console.warn("[AI Raw HTML Fragment Renderer] KaTeX auto-render is not loaded; LaTeX will remain as text.");
        didWarnMissingKatex = true;
      }
      return;
    }

    ensureKatexStylesheet();

    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false }
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      ignoredClasses: ["no-latex", "no-katex"],
      throwOnError: false,
      strict: "warn",
      trust: false
    });
  }


  function makeSmallButton(buttonText) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = buttonText;
    button.setAttribute("data-html-render-small-button", "1");
    applySmallButtonTheme(button);

    return button;
  }


  function makeToolbar(labelText, buttonText) {
    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-html-render-toolbar", "1");
    applyToolbarTheme(toolbar);

    const label = document.createElement("span");
    label.textContent = labelText;

    const actions = document.createElement("div");
    actions.style.cssText = [
      "display: flex",
      "align-items: center",
      "gap: 6px",
      "flex-wrap: wrap",
      "justify-content: flex-end"
    ].join("; ");

    const button = makeSmallButton(buttonText);

    actions.append(button);
    toolbar.append(label, actions);

    return { toolbar, button, actions };
  }

  function getElementPixelSize(el) {
    const rect = el.getBoundingClientRect();

    const width = Math.max(
      1,
      Math.ceil(rect.width || el.scrollWidth || el.offsetWidth || 1)
    );

    const height = Math.max(
      1,
      Math.ceil(rect.height || el.scrollHeight || el.offsetHeight || 1)
    );

    return { width, height };
  }

  function triggerDownload(dataURL, filename) {
    const a = document.createElement("a");
    a.href = dataURL;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyTextToClipboard(text) {
    const value = String(text || "");

    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // Fall back to the textarea path below.
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = [
      "position: fixed",
      "left: -9999px",
      "top: 0",
      "opacity: 0",
      "pointer-events: none"
    ].join("; ");

    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }

  function selectElementText(el) {
    if (!el) return;

    const selection = window.getSelection?.();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function clearTextSelection() {
    window.getSelection?.()?.removeAllRanges();
  }

  function isHttpURL(url) {
    return /^https?:\/\//i.test(String(url || ""));
  }

  function isDataURL(url) {
    return /^data:/i.test(String(url || ""));
  }

  function isBlobURL(url) {
    return /^blob:/i.test(String(url || ""));
  }

  function isLocalFragmentURL(url) {
    return /^#/i.test(String(url || ""));
  }

  function absoluteURL(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Blob 转 DataURL 失败"));

      reader.readAsDataURL(blob);
    });
  }

  function gmFetchBlob(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest 不可用，请确认脚本头部包含 @grant GM_xmlhttpRequest"));
        return;
      }

      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout: 20000,
        onload(response) {
          if (response.status >= 200 && response.status < 300 && response.response) {
            resolve(response.response);
          } else {
            reject(new Error(`资源请求失败：${response.status}`));
          }
        },
        onerror() {
          reject(new Error("资源请求失败"));
        },
        ontimeout() {
          reject(new Error("资源请求超时"));
        }
      });
    });
  }

  async function urlToDataURL(url) {
    const raw = String(url || "").trim();
    if (!raw) return raw;

    if (isDataURL(raw)) return raw;
    if (isLocalFragmentURL(raw)) return raw;

    const finalURL = absoluteURL(raw);

    if (!isHttpURL(finalURL) && !isBlobURL(finalURL)) {
      return raw;
    }

    const blob = await gmFetchBlob(finalURL);
    return blobToDataURL(blob);
  }

  // src/input-adapters.js
  function isVisibleElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  function isTextInputElement(el) {
    const tag = el?.tagName?.toLowerCase();
    if (tag === "textarea") return true;

    if (tag === "input") {
      const type = String(el.getAttribute("type") || "text").toLowerCase();
      return ["", "text", "search"].includes(type);
    }

    return false;
  }

  function isEditableElement(el) {
    return Boolean(
      el &&
        !isPluginNode(el) &&
        (
          isTextInputElement(el) ||
          el.isContentEditable ||
          el.getAttribute?.("role") === "textbox"
        )
    );
  }

  function getFocusedEditable() {
    const active = document.activeElement;
    if (isEditableElement(active) && isVisibleElement(active)) return active;
    return null;
  }

  function getPromptInputCandidates() {
    const selectors = [
      "textarea",
      "input[type='text']",
      "input[type='search']",
      "[contenteditable='true']",
      "[role='textbox']",
      "#prompt-textarea",
      ".ProseMirror"
    ];

    return queryAll(selectors)
      .filter(el => isEditableElement(el))
      .filter(el => isVisibleElement(el))
      .filter(el => !el.closest("[data-html-render-prompt-injector='1']"));
  }

  function getEditableText(el) {
    if (!el) return "";
    if (isTextInputElement(el)) return el.value || "";
    return el.innerText || el.textContent || "";
  }

  function setNativeInputValue(el, value) {
    const tag = el.tagName?.toLowerCase();
    const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
  }

  function dispatchEditableInputEvents(el) {
    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: null
      }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setTextInputValue(el, value) {
    setNativeInputValue(el, value);

    const length = value.length;
    el.focus();
    el.setSelectionRange?.(length, length);
    dispatchEditableInputEvents(el);
  }

  function setContentEditableValue(el, value) {
    el.focus();

    try {
      const selection = window.getSelection();
      const range = document.createRange();

      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      if (document.execCommand("insertText", false, value)) {
        dispatchEditableInputEvents(el);
        return;
      }
    } catch {
      // Fall back to direct text replacement below.
    }

    el.replaceChildren(document.createTextNode(value));
    dispatchEditableInputEvents(el);
  }

  function setEditableText(el, value) {
    if (isTextInputElement(el)) {
      setTextInputValue(el, value);
      return;
    }

    setContentEditableValue(el, value);
  }

  function findPromptInput() {
    return getFocusedEditable() || getPromptInputCandidates().at(-1) || null;
  }

  // src/prompt-injector.js
  function buildPromptInjectionText(existingText) {
    const value = String(existingText || "");

    if (!value) {
      return HTML_VISUAL_PROMPT;
    }

    return `${HTML_VISUAL_PROMPT}\n\n---\n\n${value}`;
  }

  function alreadyHasPromptPreset(text) {
    const value = String(text || "");
    return value.includes("<format>") && value.includes(HTML_VISUAL_PROMPT_TITLE);
  }

  function setPromptInjectorStatus(button, text) {
    const oldText = button.textContent;
    button.textContent = text;

    clearTimeout(button.__htmlRenderStatusTimer);
    button.__htmlRenderStatusTimer = setTimeout(() => {
      button.textContent = oldText || "注入提示词";
    }, 1100);
  }


  function makePromptInjectorButton() {
    const button = makeSmallButton("注入提示词");

    button.setAttribute("data-html-render-prompt-injector", "1");
    applyPromptInjectorTheme(button);

    button.addEventListener("click", () => {
      const input = findPromptInput();

      if (!input) {
        setPromptInjectorStatus(button, "没找到输入框");
        return;
      }

      const currentText = getEditableText(input);

      if (alreadyHasPromptPreset(currentText)) {
        input.focus();
        setPromptInjectorStatus(button, "已存在");
        return;
      }

      const nextText = buildPromptInjectionText(currentText);
      if (currentText && !nextText.includes(currentText)) {
        setPromptInjectorStatus(button, "保护中止");
        return;
      }

      setEditableText(input, nextText);
      setPromptInjectorStatus(button, currentText ? "已前置注入" : "已注入");
    });

    return button;
  }

  function initPromptInjector() {
    if (document.querySelector("[data-html-render-prompt-injector='1']")) return;

    const button = makePromptInjectorButton();
    (document.body || document.documentElement).appendChild(button);
  }

  // src/export-resources.js

  function makeImagePlaceholder(width, height, text) {
    const theme = getRendererTheme();
    const box = document.createElement("div");

    box.style.cssText = [
      `width: ${Math.max(24, width || 120)}px`,
      `height: ${Math.max(24, height || 80)}px`,
      "box-sizing: border-box",
      "display: flex",
      "align-items: center",
      "justify-content: center",
      `border: 1px dashed ${theme.borderStrong}`,
      "border-radius: 8px",
      `background: ${theme.surfaceSoft}`,
      `color: ${theme.textFaint}`,
      "font-size: 12px",
      "line-height: 1.4",
      "text-align: center",
      "padding: 8px"
    ].join("; ");

    box.textContent = text || "图片无法导出";
    return box;
  }

  function splitSrcset(srcset) {
    return String(srcset || "")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const parts = item.split(/\s+/);
        return {
          url: parts[0],
          descriptor: parts.slice(1).join(" ")
        };
      });
  }

  async function inlineSrcsetValue(srcset) {
    const items = splitSrcset(srcset);
    const result = [];

    for (const item of items) {
      try {
        const dataURL = await urlToDataURL(item.url);
        result.push([dataURL, item.descriptor].filter(Boolean).join(" "));
      } catch {
        // 丢弃无法内联的 srcset 项，避免污染 canvas。
      }
    }

    return result.join(", ");
  }

  function getRenderedImageSize(el) {
    const rect = el.getBoundingClientRect?.() || {};
    return {
      width: Number(el.getAttribute?.("width")) || Math.ceil(rect.width || el.width || 120),
      height: Number(el.getAttribute?.("height")) || Math.ceil(rect.height || el.height || 80)
    };
  }

  async function inlineMediaElement(el) {
    const tag = el.tagName?.toLowerCase();

    if (tag === "img") {
      const src = el.getAttribute("src");
      const srcset = el.getAttribute("srcset");

      try {
        if (src && !isDataURL(src)) {
          el.setAttribute("src", await urlToDataURL(src));
        }

        if (srcset) {
          const newSrcset = await inlineSrcsetValue(srcset);
          if (newSrcset) {
            el.setAttribute("srcset", newSrcset);
          } else {
            el.removeAttribute("srcset");
          }
        }

        el.removeAttribute("crossorigin");
        el.removeAttribute("loading");
        el.removeAttribute("decoding");
      } catch (err) {
        console.warn("[AI Raw HTML Fragment Renderer] img 内联失败：", src, err);
        const size = getRenderedImageSize(el);
        el.replaceWith(makeImagePlaceholder(size.width, size.height, "图片跨域，已替换"));
      }

      return;
    }

    if (tag === "source") {
      const src = el.getAttribute("src");
      const srcset = el.getAttribute("srcset");

      try {
        if (src && !isDataURL(src)) {
          el.setAttribute("src", await urlToDataURL(src));
        }

        if (srcset) {
          const newSrcset = await inlineSrcsetValue(srcset);
          if (newSrcset) {
            el.setAttribute("srcset", newSrcset);
          } else {
            el.removeAttribute("srcset");
          }
        }
      } catch {
        el.remove();
      }

      return;
    }

    if (tag === "video") {
      const poster = el.getAttribute("poster");
      if (poster && !isDataURL(poster)) {
        try {
          el.setAttribute("poster", await urlToDataURL(poster));
        } catch {
          el.removeAttribute("poster");
        }
      }

      el.removeAttribute("src");
      return;
    }

    if (tag === "audio") {
      el.removeAttribute("src");
    }
  }

  async function inlineSVGResourceElement(el) {
    const tag = el.tagName?.toLowerCase();

    if (tag !== "image" && tag !== "use") return;

    const href =
      el.getAttribute("href") ||
      el.getAttribute("xlink:href") ||
      el.getAttributeNS?.("http://www.w3.org/1999/xlink", "href");

    if (!href || isDataURL(href) || isLocalFragmentURL(href)) return;

    if (tag === "use") {
      el.remove();
      return;
    }

    try {
      const dataURL = await urlToDataURL(href);
      el.setAttribute("href", dataURL);
      el.setAttributeNS?.("http://www.w3.org/1999/xlink", "href", dataURL);
    } catch (err) {
      console.warn("[AI Raw HTML Fragment Renderer] SVG image 内联失败：", href, err);
      el.remove();
    }
  }

  function findCSSURLs(value) {
    const urls = [];
    const re = /url\((['"]?)(.*?)\1\)/gi;
    let match;

    while ((match = re.exec(String(value || "")))) {
      const url = match[2]?.trim();
      if (url) urls.push(url);
    }

    return urls;
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async function inlineCSSURLValue(value) {
    let output = String(value || "");
    const urls = findCSSURLs(output);

    for (const url of urls) {
      if (isDataURL(url) || isLocalFragmentURL(url)) continue;

      try {
        const dataURL = await urlToDataURL(url);
        output = output.split(url).join(dataURL);
      } catch {
        output = output.replace(new RegExp(`url\\((['"]?)${escapeRegExp(url)}\\1\\)`, "g"), "none");
      }
    }

    return output;
  }

  async function inlineStyleURLs(root) {
    const elements = [root, ...Array.from(root.querySelectorAll("*"))];

    const urlProps = [
      "background-image",
      "border-image-source",
      "list-style-image",
      "mask-image",
      "-webkit-mask-image",
      "cursor",
      "filter"
    ];

    for (const el of elements) {
      if (!el.style) continue;

      for (const prop of urlProps) {
        const value = el.style.getPropertyValue(prop);
        if (!value || !/url\(/i.test(value)) continue;

        try {
          const next = await inlineCSSURLValue(value);
          el.style.setProperty(prop, next);
        } catch {
          el.style.removeProperty(prop);
        }
      }

      const styleText = el.getAttribute("style");
      if (styleText && /url\(/i.test(styleText)) {
        try {
          el.setAttribute("style", await inlineCSSURLValue(styleText));
        } catch {
          el.setAttribute("style", styleText.replace(/url\((['"]?).*?\1\)/gi, "none"));
        }
      }
    }
  }

  function hasUnsupportedColorFunction(value) {
    return /\b(?:lab|lch|oklab|oklch|color|color-mix)\s*\(/i.test(String(value || ""));
  }


  function getSafeColorFallback(prop, value) {
    const theme = getRendererTheme();
    const p = String(prop || "").toLowerCase();
    const v = String(value || "").toLowerCase();

    if (v.includes("transparent")) return "transparent";

    if (
      p.includes("background") ||
      p.includes("shadow") ||
      p.includes("filter") ||
      p.includes("mask")
    ) {
      return p.includes("background") ? "transparent" : "none";
    }

    if (
      p.includes("border") ||
      p.includes("outline") ||
      p.includes("decoration") ||
      p.includes("rule")
    ) {
      return theme.border;
    }

    if (p === "fill" || p === "stroke") {
      return p === "fill" ? "currentColor" : theme.border;
    }

    return theme.textStrong;
  }

  function normalizeUnsupportedColorFunctions(root) {
    const elements = [root, ...Array.from(root.querySelectorAll("*"))];

    const props = [
      "color",
      "background",
      "background-color",
      "background-image",
      "border-color",
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
      "outline-color",
      "text-decoration-color",
      "caret-color",
      "column-rule-color",
      "box-shadow",
      "text-shadow",
      "fill",
      "stroke",
      "filter",
      "backdrop-filter",
      "-webkit-backdrop-filter"
    ];

    for (const el of elements) {
      if (!el.style) continue;

      for (const prop of props) {
        const value = el.style.getPropertyValue(prop);

        if (value && hasUnsupportedColorFunction(value)) {
          el.style.setProperty(prop, getSafeColorFallback(prop, value));
        }
      }

      for (let i = el.style.length - 1; i >= 0; i -= 1) {
        const prop = el.style[i];
        const value = el.style.getPropertyValue(prop);

        if (!value || !hasUnsupportedColorFunction(value)) continue;

        if (prop.startsWith("--")) {
          el.style.removeProperty(prop);
        } else {
          el.style.setProperty(prop, getSafeColorFallback(prop, value));
        }
      }

      const styleText = el.getAttribute("style");

      if (styleText && hasUnsupportedColorFunction(styleText)) {
        let cleaned = styleText;

        cleaned = cleaned.replace(/(?:^|;)\s*--[^:]+:\s*[^;]*(?:lab|lch|oklab|oklch|color|color-mix)\s*\([^;]+;?/gi, ";");
        cleaned = cleaned.replace(/\b(?:lab|lch|oklab|oklch|color|color-mix)\s*\([^)]*\)/gi, "rgb(17,17,17)");

        el.setAttribute("style", cleaned);
      }
    }
  }

  function revealElementForExport(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;

    el.hidden = false;
    el.removeAttribute("hidden");
    el.setAttribute("aria-hidden", "false");

    el.style.setProperty("display", "block");
    el.style.setProperty("visibility", "visible");
    el.style.setProperty("opacity", "1");
    el.style.setProperty("height", "auto");
    el.style.setProperty("max-height", "none");
    el.style.setProperty("overflow", "visible");
    el.style.setProperty("pointer-events", "auto");

    const position = window.getComputedStyle(el).position;
    if (position === "fixed" || position === "absolute") {
      el.style.setProperty("position", "static");
      el.style.setProperty("transform", "none");
      el.style.setProperty("left", "auto");
      el.style.setProperty("top", "auto");
      el.style.setProperty("right", "auto");
      el.style.setProperty("bottom", "auto");
    }
  }


  function replaceSelectWithExpandedList(select) {
    const theme = getRendererTheme();
    const wrapper = document.createElement("div");
    const rect = select.getBoundingClientRect?.() || {};
    const selectedValues = new Set(
      Array.from(select.selectedOptions || []).map(option => option.value)
    );

    wrapper.style.cssText = [
      `width: ${Math.max(120, Math.ceil(rect.width || select.offsetWidth || 160))}px`,
      "box-sizing: border-box",
      `border: 1px solid ${theme.borderStrong}`,
      "border-radius: 8px",
      `background: ${theme.surfaceRaised}`,
      "overflow: hidden",
      "font-size: 13px",
      "line-height: 1.4",
      `color: ${theme.text}`
    ].join("; ");

    const label = document.createElement("div");
    label.textContent = select.getAttribute("aria-label") || select.name || "下拉选项";
    label.style.cssText = [
      "padding: 7px 9px",
      `background: ${theme.surfaceSoft}`,
      "font-size: 12px",
      `color: ${theme.textMuted}`,
      `border-bottom: 1px solid ${theme.border}`
    ].join("; ");

    wrapper.appendChild(label);

    Array.from(select.options || []).forEach(option => {
      const item = document.createElement("div");
      const selected = selectedValues.has(option.value);

      item.textContent = option.textContent || option.value || "";
      item.style.cssText = [
        "padding: 7px 9px",
        `border-bottom: 1px solid ${theme.border}`,
        selected ? `background: ${theme.surfaceSoft}` : `background: ${theme.surfaceRaised}`,
        selected ? "font-weight: 600" : "font-weight: 400"
      ].join("; ");

      wrapper.appendChild(item);
    });

    select.replaceWith(wrapper);
  }

  function expandDropdownsForExport(root) {
    root.querySelectorAll("details").forEach(details => {
      details.setAttribute("open", "");
      details.open = true;
    });

    root.querySelectorAll("select").forEach(select => {
      replaceSelectWithExpandedList(select);
    });

    root.querySelectorAll("[aria-expanded]").forEach(el => {
      el.setAttribute("aria-expanded", "true");
    });

    root.querySelectorAll("[data-state='closed']").forEach(el => {
      el.setAttribute("data-state", "open");
    });

    root.querySelectorAll("[data-headlessui-state]").forEach(el => {
      const state = el.getAttribute("data-headlessui-state") || "";
      if (!state.includes("open")) {
        el.setAttribute("data-headlessui-state", `${state} open`.trim());
      }
    });

    const triggers = Array.from(
      root.querySelectorAll("[aria-haspopup], [aria-controls], [aria-owns], [role='combobox']")
    );

    for (const trigger of triggers) {
      trigger.setAttribute("aria-expanded", "true");

      const ids = [
        trigger.getAttribute("aria-controls"),
        trigger.getAttribute("aria-owns")
      ].filter(Boolean);

      for (const id of ids) {
        try {
          const panel = root.querySelector(`#${CSS.escape(id)}`);
          if (panel) revealElementForExport(panel);
        } catch {
          // Ignore invalid id.
        }
      }

      const next = trigger.nextElementSibling;
      if (
        next &&
        (
          next.matches("[role='menu'], [role='listbox'], [role='dialog'], [data-state], [hidden], [aria-hidden='true']") ||
          /menu|popover|dropdown|select|listbox/i.test(next.className || "")
        )
      ) {
        revealElementForExport(next);
      }
    }

    root.querySelectorAll(
      [
        "[role='menu']",
        "[role='listbox']",
        "[role='option']",
        "[role='dialog']",
        "[data-radix-popper-content-wrapper]",
        "[data-radix-menu-content]",
        "[data-radix-select-content]",
        "[data-headlessui-state*='open']",
        "[data-state='open']"
      ].join(", ")
    ).forEach(revealElementForExport);
  }

  function removeDangerousOrExternalNodes(root) {
    root.querySelectorAll("script, iframe, object, embed, link, meta").forEach(node => node.remove());

    root.querySelectorAll("canvas").forEach(canvas => {
      const size = getRenderedImageSize(canvas);
      canvas.replaceWith(makeImagePlaceholder(size.width, size.height, "Canvas 已替换"));
    });

    root.querySelectorAll("video, audio").forEach(media => {
      media.removeAttribute("src");
      media.querySelectorAll("source").forEach(source => source.remove());
    });
  }

  function copyCanvasFriendlyStyles(source, clone) {
    const sourceWalker = document.createTreeWalker(source, NodeFilter.SHOW_ELEMENT);
    const cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);

    let sourceNode = source;
    let cloneNode = clone;

    while (sourceNode && cloneNode) {
      try {
        const computed = window.getComputedStyle(sourceNode);

        const importantProps = [
          "display",
          "position",
          "box-sizing",
          "width",
          "height",
          "min-width",
          "min-height",
          "max-width",
          "max-height",
          "margin",
          "padding",
          "border",
          "border-width",
          "border-style",
          "border-color",
          "border-radius",
          "background-color",
          "color",
          "font",
          "font-family",
          "font-size",
          "font-weight",
          "font-style",
          "line-height",
          "letter-spacing",
          "text-align",
          "text-decoration",
          "white-space",
          "word-break",
          "overflow",
          "opacity",
          "transform",
          "transform-origin",
          "justify-content",
          "align-items",
          "align-content",
          "flex-direction",
          "flex-wrap",
          "gap",
          "row-gap",
          "column-gap",
          "grid-template-columns",
          "grid-template-rows",
          "grid-auto-flow",
          "grid-gap"
        ];

        for (const prop of importantProps) {
          const value = computed.getPropertyValue(prop);
          if (!value) continue;

          if (hasUnsupportedColorFunction(value)) {
            cloneNode.style.setProperty(prop, getSafeColorFallback(prop, value));
          } else {
            cloneNode.style.setProperty(prop, value);
          }
        }
      } catch {
        // Ignore unreadable computed style.
      }

      sourceNode = sourceWalker.nextNode();
      cloneNode = cloneWalker.nextNode();
    }
  }

  async function sanitizeExportResources(clone) {
    removeDangerousOrExternalNodes(clone);
    expandDropdownsForExport(clone);

    const elements = [clone, ...Array.from(clone.querySelectorAll("*"))];

    for (const el of elements) {
      await inlineMediaElement(el);
      await inlineSVGResourceElement(el);

      for (const attr of ["href", "xlink:href"]) {
        const value = el.getAttribute?.(attr);
        if (!value || isDataURL(value) || isLocalFragmentURL(value)) continue;

        if (isHttpURL(absoluteURL(value)) || isBlobURL(value)) {
          el.removeAttribute(attr);
        }
      }
    }

    await inlineStyleURLs(clone);
    normalizeUnsupportedColorFunctions(clone);
  }

  // src/export-png.js
  async function makeExportClone(target, width) {
    const clone = target.cloneNode(true);

    copyCanvasFriendlyStyles(target, clone);

    clone.style.boxSizing = "border-box";
    clone.style.width = `${width}px`;
    clone.style.minWidth = `${width}px`;
    clone.style.maxWidth = `${width}px`;
    clone.style.margin = "0";
    clone.style.overflow = "visible";

    await sanitizeExportResources(clone);

    return clone;
  }

  async function downloadRenderedPNG(target, filename = "html-render-card.png") {
    if (!target) return;

    if (typeof window.html2canvas !== "function") {
      throw new Error("html2canvas 未加载。请确认 userscript 头部包含 @require html2canvas。");
    }

    const { width } = getElementPixelSize(target);
    const clone = await makeExportClone(target, width);

    const stage = document.createElement("div");
    stage.setAttribute("data-html-render-export-stage", "1");
    stage.style.cssText = [
      "position: fixed",
      "left: 0",
      "top: 0",
      "z-index: -2147483647",
      "box-sizing: border-box",
      "padding: 0",
      "margin: 0",
      "background: transparent",
      "opacity: 1",
      "pointer-events: none",
      "overflow: visible"
    ].join("; ");

    stage.appendChild(clone);

    if (observer) {
      observer.disconnect();
    }

    document.body.appendChild(stage);

    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      normalizeUnsupportedColorFunctions(clone);

      const finalRect = clone.getBoundingClientRect();
      const finalWidth = Math.max(1, Math.ceil(finalRect.width || clone.scrollWidth || width || 1));
      const finalHeight = Math.max(1, Math.ceil(finalRect.height || clone.scrollHeight || 1));

      const canvas = await window.html2canvas(clone, {
        backgroundColor: null,
        scale: PNG_SCALE,
        useCORS: false,
        allowTaint: false,
        foreignObjectRendering: false,
        logging: false,
        width: finalWidth,
        height: finalHeight,
        windowWidth: Math.max(document.documentElement.clientWidth, finalWidth),
        windowHeight: Math.max(document.documentElement.clientHeight, finalHeight),
        scrollX: 0,
        scrollY: 0,
        x: 0,
        y: 0,
        onclone(clonedDocument) {
          const clonedStage = clonedDocument.querySelector("[data-html-render-export-stage='1']");
          if (clonedStage) {
            normalizeUnsupportedColorFunctions(clonedStage);
          }
        }
      });

      triggerDownload(canvas.toDataURL("image/png"), filename);
    } finally {
      stage.remove();

      if (observer) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true
        });
      }

      scheduleScan();
    }
  }

  // src/render-blocks.js

  function makeRenderedBlock(rawHTML) {
    const theme = getRendererTheme();
    const outer = document.createElement("div");
    outer.setAttribute("data-html-rendered-block", "1");
    outer.setAttribute("data-html-render-block-id", String(++blockSeq));
    outer.setAttribute("data-html-render-theme", theme.name);
    outer.style.cssText = "margin: 12px 0; padding: 0; border: 0";

    const { toolbar, button, actions } = makeToolbar("HTML Rendered Locally", "源码");

    const downloadButton = makeSmallButton("下载 PNG");
    actions.insertBefore(downloadButton, button);

    const rendered = document.createElement("div");
    rendered.setAttribute("data-html-render-content", "1");
    renderRawHTMLIntoContainer(rendered, rawHTML);

    const sourceText = String(rawHTML || "").trim();
    outer.__htmlRenderOriginalRawHTML = sourceText;

    const source = document.createElement("pre");
    source.setAttribute("data-html-render-source", "1");
    source.textContent = sourceText;
    applySourceBlockTheme(source, theme);

    button.addEventListener("click", async () => {
      const showSource = source.style.display === "none";
      source.style.display = showSource ? "block" : "none";
      source.setAttribute("data-html-render-source-display", source.style.display);
      rendered.style.display = showSource ? "none" : "block";

      if (!showSource) {
        clearTextSelection();
        button.textContent = "源码";
        return;
      }

      selectElementText(source);
      button.textContent = "复制中...";

      const copied = await copyTextToClipboard(sourceText);
      if (!copied) {
        console.warn("[AI Raw HTML Fragment Renderer] source copy failed.");
      }

      button.textContent = copied ? "已复制" : "复制失败";

      setTimeout(() => {
        if (source.style.display !== "none") {
          button.textContent = "渲染";
        }
      }, 900);
    });

    downloadButton.addEventListener("click", async () => {
      const content = outer.querySelector("[data-html-render-content='1']");
      const id = outer.getAttribute("data-html-render-block-id") || Date.now();

      const oldText = downloadButton.textContent;
      downloadButton.disabled = true;
      downloadButton.textContent = "导出中...";

      try {
        await downloadRenderedPNG(content, `html-render-card-${id}.png`);
      } catch (err) {
        console.error("[AI Raw HTML Fragment Renderer] PNG export failed:", err);
        alert(
          "PNG 导出失败：\n\n" +
            (err?.message || String(err)) +
            "\n\n当前版本使用 html2canvas 直接渲染 DOM；导出前会展开 details、select、menu、listbox、combobox，并清理 lab/oklch/color-mix 等 html2canvas 不支持的颜色函数。导出期间会暂停 MutationObserver，避免导出克隆干扰页面渲染。"
        );
      } finally {
        downloadButton.disabled = false;
        downloadButton.textContent = oldText;
      }
    });

    outer.append(toolbar, rendered, source);

    activateRenderedContainer(rendered);

    return outer;
  }


  function makeFallbackBlock(text) {
    const theme = getRendererTheme();
    const pre = document.createElement("pre");
    pre.setAttribute("data-html-render-fallback", "1");
    pre.textContent = text;
    applyFallbackBlockTheme(pre, theme);

    return pre;
  }


  function makeLivePreviewBlock() {
    const theme = getRendererTheme();
    const outer = document.createElement("div");
    outer.setAttribute("data-html-render-live-preview", "1");
    outer.setAttribute("data-html-render-preview-id", String(++blockSeq));
    outer.setAttribute("data-html-render-theme", theme.name);
    outer.style.cssText = "margin: 12px 0; padding: 0; border: 0";

    const { toolbar } = makeToolbar("HTML Live Preview", "流式预览");

    const rendered = document.createElement("div");
    rendered.setAttribute("data-html-render-live-content", "1");

    const hint = document.createElement("div");
    hint.setAttribute("data-html-render-live-hint", "1");
    hint.textContent = "源码已临时隐藏；HTML 会就地预览。闭合后会执行脚本并固化为正式渲染块。";
    applyLiveHintTheme(hint, theme);

    outer.append(toolbar, rendered, hint);
    return outer;
  }


  function updateLivePreviewBlock(block, rawHTML) {
    const theme = getRendererTheme();
    const rendered = block.querySelector("[data-html-render-live-content='1']");
    if (!rendered) return;

    block.__htmlRenderRawHTML = String(rawHTML || "");
    block.setAttribute("data-html-render-theme", theme.name);

    try {
      renderRawHTMLIntoContainer(rendered, rawHTML);

      rendered.dispatchEvent(
        new CustomEvent("html-render-live-update", {
          bubbles: true,
          detail: { container: rendered }
        })
      );
    } catch {
      const placeholder = document.createElement("pre");
      placeholder.textContent = String(rawHTML || "");
      placeholder.style.cssText = [
        "white-space: pre-wrap",
        "word-break: break-word",
        "margin: 0",
        "padding: 10px",
        `border: 1px solid ${theme.border}`,
        "border-radius: 8px",
        `background: ${theme.surfaceSoft}`,
        `color: ${theme.text}`,
        "font-size: 12px",
        "line-height: 1.5"
      ].join("; ");

      rendered.appendChild(placeholder);
    }
  }

  function executeScripts(container) {
    setupDeclarativeInteractions(container);

    const scripts = Array.from(container.querySelectorAll("script"));

    for (const script of scripts) {
      script.dataset.htmlRenderScriptSkipped = "1";
    }
  }

  function dispatchReadyEvent(container) {
    const event = new CustomEvent("html-render-ready", {
      bubbles: true,
      detail: { container }
    });

    container.dispatchEvent(event);
  }

  function setupDeclarativeInteractions(container) {
    const roots = Array.from(container.querySelectorAll("[data-html-interaction-id]"));

    for (const root of roots) {
      setupStepDetailsInteraction(root);
    }
  }

  function setupStepDetailsInteraction(root) {
    if (!root || root.dataset.htmlRenderInteractionBound === "1") return;

    const interactionId = root.getAttribute("data-html-interaction-id");
    if (!interactionId) return;

    const buttons = getOwnedElements(root, "[data-step]");
    if (!buttons.length) return;

    const data = getStepDetailsData(root, interactionId);
    if (!data || !Object.keys(data).length) return;

    const title = getOwnedElement(root, "[data-role='title']");
    const desc = getOwnedElement(root, "[data-role='desc']");
    if (!title && !desc) return;

    const firstActiveButton = buttons.find(button => {
      const style = String(button.getAttribute("style") || "");
      return /aria-pressed\s*=\s*["\']?true/i.test(button.outerHTML || "") || /background\s*:\s*(#111|#f4f4f5|rgb\(17,\s*17,\s*17\)|rgb\(244,\s*244,\s*245\)|black|white)/i.test(style);
    }) || buttons[0];

    const firstInactiveButton = buttons.find(button => button !== firstActiveButton);
    const activeStyle = firstActiveButton.getAttribute("style") || "";
    const inactiveStyle = firstInactiveButton?.getAttribute("style") || activeStyle;

    function activate(button) {
      const key = button.getAttribute("data-step");
      const item = data[key];
      if (!item) return;

      if (title && item.title != null) title.textContent = item.title;
      if (desc && (item.desc != null || item.description != null)) {
        desc.textContent = item.desc ?? item.description;
      }

      for (const itemButton of buttons) {
        itemButton.setAttribute("aria-pressed", itemButton === button ? "true" : "false");

        if (inactiveStyle) itemButton.setAttribute("style", inactiveStyle);
      }

      if (activeStyle) button.setAttribute("style", activeStyle);
    }

    for (const button of buttons) {
      button.type = "button";
      button.addEventListener("click", () => activate(button));
    }

    root.dataset.htmlRenderInteractionBound = "1";
  }

  function getStepDetailsData(root, interactionId) {
    return getJSONStepDetailsData(root, interactionId);
  }

  function getJSONStepDetailsData(root, interactionId) {
    const scripts = getOwnedElements(
      root,
      `script[type="application/json"][data-html-interaction-for="${escapeAttributeSelectorValue(interactionId)}"]`
    );

    for (const script of scripts) {
      try {
        const parsed = JSON.parse(script.textContent || "{}");
        const data = normalizeStepDetailsData(parsed);
        if (data) return data;
      } catch (err) {
        console.warn("[AI Raw HTML Fragment Renderer] interaction JSON parse failed:", err);
      }
    }

    return null;
  }

  function getOwnedElement(root, selector) {
    return getOwnedElements(root, selector)[0] || null;
  }

  function getOwnedElements(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter(
      el => el.closest("[data-html-interaction-id]") === root
    );
  }

  function escapeAttributeSelectorValue(value) {
    return String(value || "").replace(/["\\]/g, "\\$&");
  }

  function normalizeStepDetailsData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;

    const source = value.steps || value.items || value.data || value;
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;

    const result = {};

    for (const [key, item] of Object.entries(source)) {
      if (!key || !item || typeof item !== "object" || Array.isArray(item)) continue;

      const title = item.title;
      const desc = item.desc ?? item.description;

      if (title == null && desc == null) continue;

      result[key] = {
        title: title == null ? "" : String(title),
        desc: desc == null ? "" : String(desc)
      };
    }

    return Object.keys(result).length ? result : null;
  }

  // src/platform-roots.js
  function isPluginNode(el) {
    return Boolean(
      el?.closest?.(
        [
          "[data-html-rendered-block='1']",
            "[data-html-render-fallback='1']",
            "[data-html-render-live-preview='1']",
            "[data-html-render-export-stage='1']",
            "[data-html-render-prompt-injector='1']"
          ].join(", ")
        )
      );
  }

  function isUnsafeScanContainer(el) {
    return Boolean(
      !el ||
        isPluginNode(el) ||
        el.closest("textarea, input, select, option, [contenteditable='true']")
    );
  }

  function uniqueElements(elements) {
    const seen = new Set();
    const result = [];

    for (const el of elements) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      result.push(el);
    }

    return result;
  }

  function getHostname() {
    return window.location.hostname.replace(/^www\./, "");
  }

  function queryAll(selectors) {
    const result = [];

    for (const selector of selectors) {
      try {
        document.querySelectorAll(selector).forEach(el => result.push(el));
      } catch {
        // Ignore invalid selectors on unusual browsers.
      }
    }

    return uniqueElements(result);
  }

  function getAssistantMessageRoots() {
    const host = getHostname();

    const selectorMap = [
      {
        test: host === "chatgpt.com" || host === "chat.openai.com",
        selectors: [
          "[data-message-author-role='assistant']",
          "article"
        ]
      },
      {
        test: host === "claude.ai",
        selectors: [
          "[data-testid='conversation-turn']",
          "[data-testid*='message']",
          "article"
        ]
      },
      {
        test: host === "gemini.google.com",
        selectors: [
          "message-content",
          "[class*='model-response']",
          "[class*='response-content']"
        ]
      },
      {
        test: host === "perplexity.ai",
        selectors: [
          "article",
          "[data-testid*='answer']",
          "[class*='answer']"
        ]
      },
      {
        test: host === "poe.com",
        selectors: [
          "[class*='Message']",
          "[class*='message']",
          "article"
        ]
      },
      {
        test: host === "copilot.microsoft.com" || host === "bing.com",
        selectors: [
          "cib-message",
          "[class*='ac-textBlock']",
          "[class*='message']"
        ]
      },
      {
        test: host === "chat.mistral.ai",
        selectors: [
          "[class*='message']",
          "[class*='assistant']",
          "article"
        ]
      },
      {
        test: host === "chat.deepseek.com",
        selectors: [
          "[class*='ds-markdown']",
          "[class*='message']",
          "[class*='assistant']"
        ]
      },
      {
        test: host === "kimi.moonshot.cn" || host === "kimi.com",
        selectors: [
          "[class*='markdown']",
          "[class*='message']",
          "[class*='assistant']"
        ]
      },
      {
        test: host === "doubao.com",
        selectors: [
          "[class*='markdown']",
          "[class*='message']",
          "[class*='answer']"
        ]
      },
      {
        test: host === "yuanbao.tencent.com",
        selectors: [
          "[class*='markdown']",
          "[class*='message']",
          "[class*='answer']"
        ]
      },
      {
        test: host === "chat.qwen.ai",
        selectors: [
          "[class*='markdown']",
          "[class*='message']",
          "[class*='assistant']",
          "article"
        ]
      }
    ];

    const matched = selectorMap.find(item => item.test);

    if (matched) {
      const roots = queryAll(matched.selectors)
        .filter(el => !el.closest("[data-html-render-export-stage='1']"));

      if (roots.length) return roots;
    }

    return queryAll([
      "[data-message-author-role='assistant']",
      "article",
      "[data-testid*='message']",
      "[data-testid*='answer']",
      "[class*='markdown']",
      "[class*='message']",
      "[class*='answer']",
      "[class*='response']",
      "[class*='assistant']"
    ]).filter(el => !el.closest("[data-html-render-export-stage='1']"));
  }

  // src/fragment-extraction.js
  function getTextNodes(root) {
    const nodes = [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (isUnsafeScanContainer(parent)) return NodeFilter.FILTER_REJECT;
        if (!(node.nodeValue || "").trim()) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function buildTextIndex(root) {
    const textNodes = getTextNodes(root);
    const parts = [];
    const spans = [];
    let cursor = 0;

    for (const node of textNodes) {
      const text = node.nodeValue || "";
      const start = cursor;
      const end = start + text.length;

      parts.push(text);
      spans.push({ node, start, end });
      cursor = end;
    }

    return { text: parts.join(""), spans };
  }

  function locatePosition(spans, index) {
    for (const span of spans) {
      if (index >= span.start && index <= span.end) {
        return {
          node: span.node,
          offset: index - span.start
        };
      }
    }

    return null;
  }

  function replaceTextRange(spans, startIndex, endIndex, replacementNode) {
    const start = locatePosition(spans, startIndex);
    const end = locatePosition(spans, endIndex);

    if (!start || !end) return false;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    range.deleteContents();
    range.insertNode(replacementNode);
    range.detach();

    return true;
  }

  function findClosedTextFragment(root) {
    const index = buildTextIndex(root);
    const fullText = index.text;

    const startIndex = fullText.indexOf(MARKER_START);
    if (startIndex === -1) return null;

    const htmlStart = startIndex + MARKER_START.length;
    const endIndex = fullText.indexOf(MARKER_END, htmlStart);
    if (endIndex === -1) return null;

    const htmlEnd = endIndex + MARKER_END.length;

    return {
      type: "text",
      spans: index.spans,
      startIndex,
      endIndex: htmlEnd,
      rawHTML: fullText.slice(htmlStart, endIndex).trim(),
      markedText: fullText.slice(startIndex, htmlEnd)
    };
  }

  function findOpenTextFragment(root) {
    const index = buildTextIndex(root);
    const fullText = index.text;

    const startIndex = fullText.indexOf(MARKER_START);
    if (startIndex === -1) return null;

    const htmlStart = startIndex + MARKER_START.length;
    const endIndex = fullText.indexOf(MARKER_END, htmlStart);
    if (endIndex !== -1) return null;

    const rawHTML = fullText.slice(htmlStart).trim();
    if (normalizeText(rawHTML).length < LIVE_PREVIEW_MIN_CHARS) return null;

    return {
      type: "text",
      rawHTML,
      startIndex,
      spans: index.spans
    };
  }

  function getCommentNodes(root) {
    const nodes = [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT, {
      acceptNode(node) {
        const parent = node.parentElement || node.parentNode;

        if (parent?.nodeType === Node.ELEMENT_NODE && isPluginNode(parent)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function isStartComment(node) {
    return node.nodeType === Node.COMMENT_NODE && node.data.trim() === COMMENT_START;
  }

  function isEndComment(node) {
    return node.nodeType === Node.COMMENT_NODE && node.data.trim() === COMMENT_END;
  }

  function nodeToHTML(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType === Node.COMMENT_NODE) return `<!--${node.data}-->`;

    if (node.nodeType === Node.ELEMENT_NODE) {
      if (isPluginNode(node)) return "";
      return node.outerHTML || "";
    }

    return "";
  }

  function serializeFragment(fragment) {
    return Array.from(fragment.childNodes)
      .map(nodeToHTML)
      .join("")
      .trim();
  }

  function extractBetweenComments(startComment, endComment) {
    const range = document.createRange();
    range.setStartAfter(startComment);
    range.setEndBefore(endComment);

    const rawHTML = serializeFragment(range.cloneContents());
    range.detach();

    return rawHTML;
  }

  function extractAfterComment(root, startComment) {
    const range = document.createRange();
    range.setStartAfter(startComment);
    range.setEnd(root, root.childNodes.length);

    const rawHTML = serializeFragment(range.cloneContents());
    range.detach();

    return rawHTML;
  }

  function findClosedCommentFragment(root) {
    const comments = getCommentNodes(root);

    for (let i = 0; i < comments.length; i += 1) {
      const start = comments[i];
      if (!isStartComment(start)) continue;

      for (let j = i + 1; j < comments.length; j += 1) {
        const end = comments[j];
        if (!isEndComment(end)) continue;

        return {
          type: "comment",
          start,
          end,
          rawHTML: extractBetweenComments(start, end)
        };
      }
    }

    return null;
  }

  function findOpenCommentFragment(root) {
    const comments = getCommentNodes(root);
    const start = comments.find(isStartComment);

    if (!start) return null;

    const end = comments.find(node => {
      if (!isEndComment(node)) return false;
      return Boolean(start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    });

    if (end) return null;

    const rawHTML = extractAfterComment(root, start);
    if (normalizeText(rawHTML).length < LIVE_PREVIEW_MIN_CHARS) return null;

    return {
      type: "comment",
      rawHTML,
      start
    };
  }

  function replaceCommentRange(fragment, replacementNode) {
    const range = document.createRange();
    range.setStartBefore(fragment.start);
    range.setEndAfter(fragment.end);
    range.deleteContents();
    range.insertNode(replacementNode);
    range.detach();

    return true;
  }

  // src/live-preview.js
  function removeLivePreviews(root) {
    root.querySelectorAll("[data-html-render-live-preview='1']").forEach(node => node.remove());
  }

  function restoreStreamingSource(root) {
    root.querySelectorAll("[data-html-render-source-hidden='1']").forEach(el => {
      const oldDisplay = el.getAttribute("data-html-render-old-display");

      if (oldDisplay === null || oldDisplay === "") {
        el.style.removeProperty("display");
      } else {
        el.style.display = oldDisplay;
      }

      el.removeAttribute("data-html-render-source-hidden");
      el.removeAttribute("data-html-render-old-display");
    });
  }

  function hideElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (isPluginNode(el)) return;
    if (el.querySelector?.("[data-html-render-live-preview='1']")) return;
    if (el.closest?.("[data-html-render-live-preview='1']")) return;
    if (el.getAttribute("data-html-render-source-hidden") === "1") return;

    el.setAttribute("data-html-render-old-display", el.style.display || "");
    el.setAttribute("data-html-render-source-hidden", "1");
    el.style.display = "none";
  }

  function hideOpenCommentSource(root, startComment) {
    let node = startComment.nextSibling;

    while (node) {
      const next = node.nextSibling;

      if (node.nodeType === Node.ELEMENT_NODE) {
        if (!isPluginNode(node)) hideElement(node);
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        hideElement(node.parentElement);
      }

      node = next;
    }
  }

  function hideOpenTextSource(fragment) {
    for (const span of fragment.spans) {
      if (span.end <= fragment.startIndex) continue;

      const parent = span.node.parentElement;
      if (!parent || isPluginNode(parent)) continue;

      hideElement(parent);
    }
  }

  function applyStreamingSourceHide(root, fragment) {
    restoreStreamingSource(root);

    if (fragment.type === "comment") {
      hideOpenCommentSource(root, fragment.start);
      return;
    }

    if (fragment.type === "text") {
      hideOpenTextSource(fragment);
    }
  }

  function getExistingPreviewNearComment(fragment) {
    const prev = fragment.start.previousSibling;

    if (
      prev?.nodeType === Node.ELEMENT_NODE &&
      prev.getAttribute("data-html-render-live-preview") === "1"
    ) {
      return prev;
    }

    return null;
  }

  function getSafeBlockContainerFromSpan(span) {
    let el = span?.node?.parentElement;

    while (el && el !== document.body) {
      if (isPluginNode(el)) return null;

      const style = window.getComputedStyle(el);

      if (
        style.display === "block" ||
        style.display === "list-item" ||
        style.display === "flex" ||
        style.display === "grid" ||
        el.matches("p, div, article, section, li, pre, code")
      ) {
        return el;
      }

      el = el.parentElement;
    }

    return span?.node?.parentElement || null;
  }

  function getExistingPreviewNearText(fragment) {
    const firstSpan = fragment.spans.find(span => span.end > fragment.startIndex);
    const container = getSafeBlockContainerFromSpan(firstSpan);

    const before = container?.previousSibling;

    if (
      before?.nodeType === Node.ELEMENT_NODE &&
      before.getAttribute("data-html-render-live-preview") === "1"
    ) {
      return before;
    }

    return null;
  }

  function createPreviewAtCommentStart(fragment) {
    const preview = makeLivePreviewBlock();
    fragment.start.parentNode.insertBefore(preview, fragment.start);
    return preview;
  }

  function createPreviewAtTextStart(fragment) {
    const preview = makeLivePreviewBlock();

    const firstSpan = fragment.spans.find(span => span.end > fragment.startIndex);
    const container = getSafeBlockContainerFromSpan(firstSpan);

    if (!container || !container.parentNode || isPluginNode(container)) {
      preview.remove();
      return null;
    }

    container.parentNode.insertBefore(preview, container);
    return preview;
  }

  function getOrCreatePreviewForFragment(fragment) {
    if (fragment.type === "comment") {
      return getExistingPreviewNearComment(fragment) || createPreviewAtCommentStart(fragment);
    }

    if (fragment.type === "text") {
      return getExistingPreviewNearText(fragment) || createPreviewAtTextStart(fragment);
    }

    return null;
  }

  // src/scanner.js
  function processClosedFragments(root) {
    if (!root || root.dataset.htmlRenderProcessing === "1") return;

    root.dataset.htmlRenderProcessing = "1";

    try {
      restoreStreamingSource(root);

      let processedCount = 0;

      while (processedCount < MAX_FRAGMENT_PROCESS_COUNT) {
        const commentFragment = findClosedCommentFragment(root);

        if (commentFragment) {
          removeLivePreviews(root);

          const replacement = makeRenderedBlock(commentFragment.rawHTML);
          replaceCommentRange(commentFragment, replacement);

          processedCount += 1;
          continue;
        }

        const textFragment = findClosedTextFragment(root);

        if (textFragment) {
          removeLivePreviews(root);

          const replacement = makeRenderedBlock(textFragment.rawHTML);
          const ok = replaceTextRange(
            textFragment.spans,
            textFragment.startIndex,
            textFragment.endIndex,
            replacement
          );

          if (!ok) break;

          processedCount += 1;
          continue;
        }

        break;
      }
    } finally {
      delete root.dataset.htmlRenderProcessing;
    }
  }

  function processLivePreview(root) {
    if (!root || root.dataset.htmlRenderProcessing === "1") return;

    const fragment = findOpenCommentFragment(root) || findOpenTextFragment(root);

    if (!fragment) {
      restoreStreamingSource(root);
      removeLivePreviews(root);
      return;
    }

    const preview = getOrCreatePreviewForFragment(fragment);
    if (!preview) return;

    updateLivePreviewBlock(preview, fragment.rawHTML);
    applyStreamingSourceHide(root, fragment);
  }

  function scanRoot(root) {
    processClosedFragments(root);
    processLivePreview(root);
  }

  function scan() {
    const roots = getAssistantMessageRoots();

    for (const root of roots) {
      scanRoot(root);
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DELAY_MS);
  }

  // src/bootstrap.js
  observer = new MutationObserver(scheduleScan);

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  initPromptInjector();
  ensureRendererSelectionStyles();
  initThemeWatcher();

  window.__renderAIHTML = scan;
  window.__renderChatGPTHTML = scan;
  window.__refreshAIHTMLTheme = () => applyRendererThemeRefresh(true);

  scan();

  console.info("[AI Chat HTML Fragment Renderer Plus] loaded. Dynamic theme v2.5.4.");
})();
