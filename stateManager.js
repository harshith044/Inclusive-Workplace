import levenshtein from 'js-levenshtein';
import * as chrono from 'chrono-node';

const sessions = new Map();

export function initSession(sessionId, catalogId, variables) {
  sessions.set(sessionId, {
    catalogId,
    variables: variables.map(v => ({ ...v, answer: v.answer || null })),
    askedIndex: 0,
    state: 'awaiting_variable',
  });
}

export function getSession(sessionId) { return sessions.get(sessionId); }
export function clearSession(sessionId) { sessions.delete(sessionId); }

export function getAnswers(sessionId) {
  const session = getSession(sessionId);
  if (!session) return {};
  const answers = session.variables.reduce((acc, v) => {
    if (v.answer != null) {
      acc[v.name] = v.name === 'requested_for' && v.displayName ? v.displayName : v.answer;
    }
    return acc;
  }, {});
  return answers;
}

export function isComplete(sessionId) {
  const session = getSession(sessionId);
  return session ? session.variables.every(v => v.answer != null) : false;
}

export function getNextQuestion(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  while (session.askedIndex < session.variables.length) {
    const v = session.variables[session.askedIndex];
    if (v.answer == null) return v.question || `Please provide ${v.label || v.name}`;
    session.askedIndex++;
  }
  return null;
}

function wordToHour(token) {
  const map = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12 };
  token = token.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
  return map[token] ?? (Number(token) || null);
}

function parseTimeToHHmm(text, preferFirst=true) {
  if (!text) return null;
  text = text.toLowerCase().replace(/\./g,'').trim();
  const m1 = text.match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (m1) return `${String(m1[1]).padStart(2,'0')}:${m1[2]}`;
  const pm = /pm/.test(text), am = /am/.test(text);
  const num = text.match(/(\d{1,2})/);
  if (num) {
    let h = parseInt(num[1],10);
    if (pm && h<12) h+=12;
    return `${String(h).padStart(2,'0')}:00`;
  }
  const h = wordToHour(text);
  return h !== null ? `${String(h).padStart(2,'0')}:00` : null;
}

function parseDateToISO(text) {
  const results = chrono.parse(text);
  if (results.length>0) {
    const dt = results[0].start.date();
    return dt.toISOString().slice(0,10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const d = new Date(text);
  if (!isNaN(d)) return d.toISOString().slice(0,10);
  return null;
}

export function updateAnswer(sessionId, userMessage) {
  const session = getSession(sessionId);
  if (!session) return;
  const v = session.variables[session.askedIndex];
  if (!v) return;

  let finalAnswer = userMessage;

  // --- FIX 1: strip filler suffixes like "for the quiet zone"
  const fillerPatterns = [
    /\bfor the quiet zone\b/gi,
    /\bin the quiet zone\b/gi,
  ];
  fillerPatterns.forEach(p => { finalAnswer = finalAnswer.replace(p, '').trim(); });

  // Choice field matching
  if (Array.isArray(v.choices) && v.choices.length > 0) {
    const normalized = finalAnswer.toLowerCase().trim();
    let best = null, lowest = Infinity;
    for (const c of v.choices) {
      const dist = levenshtein(normalized, (c.label || '').toLowerCase());
      if (dist < lowest) { lowest = dist; best = c; }
    }
    if (best && lowest <= 3) finalAnswer = best.value ?? best.label;
  }

  // Date fields
  if (v.name.toLowerCase().includes('date')) {
    const iso = parseDateToISO(finalAnswer);
    if (iso) finalAnswer = iso;
  }

  // Time fields
  if (v.name.toLowerCase().includes('time')) {
    const preferFirst = v.name.toLowerCase().includes('start') || v.name.toLowerCase().includes('from');
    const parsed = parseTimeToHHmm(finalAnswer, preferFirst);
    if (parsed) finalAnswer = parsed;
  }

  // --- FIX 2: Combine booking_date + time into YYYY-MM-DD HH:MM:SS
  if (['booking_start_time', 'booking_end_time'].includes(v.name)) {
    const dateVar = session.variables.find(x => x.name.toLowerCase().includes('date') && x.answer);

    // Normalize date
    let datePart = null;
    if (dateVar?.answer) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateVar.answer)) {
        datePart = dateVar.answer;
      } else if (/^\d{4}-\d{2}-\d{2}T/.test(dateVar.answer)) {
        datePart = dateVar.answer.slice(0,10);
      }
    }

    // If we have both date and time
    if (datePart && /^\d{2}:\d{2}$/.test(finalAnswer)) {
      finalAnswer = `${datePart} ${finalAnswer}:00`; // format: YYYY-MM-DD HH:MM:SS
    }
  }

  v.answer = finalAnswer;
  session.askedIndex++;
}

export function tryHandleCorrection(sessionId, userMessage) {
  const session = getSession(sessionId);
  if (!session) return false;
  const regex = /(change|update|set)?\s*(\w+)\s*(to|is)?\s*(.+)/i;
  const match = userMessage.match(regex);
  if (match) {
    const [, , field, , value] = match;
    const targetVar = session.variables.find(v => v.name.toLowerCase()===field.toLowerCase() || v.label?.toLowerCase()===field.toLowerCase());
    if (targetVar) { targetVar.answer=value; return true; }
  }
  return false;
}
