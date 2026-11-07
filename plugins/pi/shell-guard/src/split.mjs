// Minimal shell segmentation. Not a full parser: it only needs to find command
// boundaries, quoted strings, heredocs, redirections and background operators
// reliably enough to classify a command. Anything uncertain is reported as
// unknown so the caller can fail open.

const HEREDOC_END = /[\s;|&)]/;

export function splitSegments(command) {
  const text = String(command ?? '');
  const segments = [];
  let current = '';
  let quote = null;

  const push = (bg) => {
    const value = current.trim();
    if (value) segments.push({ text: value, background: bg });
    current = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '\\') {
      const escaped = text[i + 1];
      // A trailing backslash (for example `dir /s C:\`) is a path, not an escape.
      if (escaped !== undefined && escaped !== '\n') {
        current += ch + escaped;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) break;

    // Heredoc: the body is data for the command, not shell syntax. Copy it
    // verbatim so `&`, `;` or quotes inside CSS/JS/Python do not become operators.
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      let j = i + 2;
      let stripTabs = false;
      if (text[j] === '-') {
        stripTabs = true;
        j += 1;
      }
      while (text[j] === ' ' || text[j] === '\t') j += 1;
      let delimiter = '';
      let delimQuote = null;
      if (text[j] === "'" || text[j] === '"') {
        delimQuote = text[j];
        j += 1;
      }
      while (j < text.length) {
        const c = text[j];
        if (delimQuote) {
          if (c === delimQuote) {
            j += 1;
            break;
          }
          delimiter += c;
          j += 1;
          continue;
        }
        if (HEREDOC_END.test(c)) break;
        delimiter += c;
        j += 1;
      }
      if (delimiter) {
        const lines = text.slice(j).split('\n');
        let endLine = -1;
        for (let k = 0; k < lines.length; k += 1) {
          const candidate = stripTabs ? lines[k].replace(/^\t+/, '') : lines[k];
          if (candidate.trimEnd() === delimiter) {
            endLine = k;
            break;
          }
        }
        if (endLine >= 0) {
          const body = lines.slice(0, endLine + 1).join('\n');
          current += text.slice(i, j) + body;
          i = j + body.length;
          continue;
        }
      }
      current += '<<';
      i += 1;
      continue;
    }

    if (ch === '&') {
      const next = text[i + 1];
      if (next === '&') {
        push(false);
        i += 1;
        continue;
      }
      // 2>&1, &>file, >&2 keep the ampersand as part of the redirection
      if (text[i - 1] === '>' || next === '>') {
        current += ch;
        continue;
      }
      push(true);
      continue;
    }

    if (ch === '|') {
      push(false);
      if (text[i + 1] === '|') i += 1;
      continue;
    }

    if (ch === ';') {
      push(false);
      continue;
    }

    current += ch;
  }

  push(false);
  return segments;
}

/** Split one segment into words, honouring single and double quotes. */
export function words(segment) {
  const out = [];
  let current = '';
  let quote = null;
  let has = false;

  for (const ch of String(segment ?? '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has) out.push(current);
  return out;
}

export function programName(token) {
  const raw = String(token ?? '').replace(/\\/g, '/');
  const base = raw.slice(raw.lastIndexOf('/') + 1);
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

export function isBackground(segments, command) {
  if (segments.some((s) => s.background)) return true;
  return /(^|[^&>])&\s*$/.test(String(command ?? '').trim());
}

/**
 * A background command is safe only when its output no longer points at the
 * harness pipe. Redirecting stdout/stderr to a file is enough; `</dev/null` is
 * recommended but not required.
 */
export function hasBackgroundRedirect(command) {
  const text = String(command ?? '');
  const toFile = /(?:^|[\s;|(])\d?>>?\s*[^\s&|;)]+/.test(text) || /&>\s*[^\s&|;)]+/.test(text);
  const stdin = /<\s*\/dev\/null/.test(text) || /<\s*NUL/i.test(text);
  return toFile || stdin;
}
