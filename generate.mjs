import https from "https";
import fs from "fs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("❌ No API key");
  process.exit(1);
}

const TIME_ZONE = "America/Denver";
const MAX_ATTEMPTS = 20;
const MIN_CLOSE_WORDS = 3;
const MAX_CLOSE_WORDS = 10;
const ALLOWED_PARTS_OF_SPEECH = new Set([
  "Noun (singular)",
  "Noun (plural)",
  "Gerund (noun)",
  "Verb",
  "Verb (infinitive)",
  "Verb (present participle)",
  "Verb (past participle)",
  "Adjective",
  "Adverb",
]);

function getLocalParts(date, timeZone = TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "long",
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

function getLocalDateString(date, timeZone = TIME_ZONE) {
  const parts = getLocalParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getPuzzleId(now, launchDateString) {
  const nowLocal = getLocalDateString(now);
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((Date.parse(`${nowLocal}T00:00:00Z`) - Date.parse(`${launchDateString}T00:00:00Z`)) / msPerDay);
  return diffDays + 1;
}

function normalizeAnswer(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function parsePuzzleJson(raw) {
  const cleaned = String(raw)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (originalError) {
    // Claude can return a complete draft followed by "wait, that answer
    // was already used" and a corrected JSON object. Use its last
    // COMPLETE puzzle object rather than repeatedly rejecting the draft.
    const candidates = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < cleaned.length; i += 1) {
      const char = cleaned[i];
      if (start < 0) {
        if (char === "{") {
          start = i;
          depth = 1;
        }
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
      } else if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const candidate = JSON.parse(cleaned.slice(start, i + 1));
            if (candidate && typeof candidate.answer === "string" &&
                Array.isArray(candidate.sentences) && Array.isArray(candidate.close)) {
              candidates.push(candidate);
            }
          } catch {
            // Ignore invalid draft JSON; another complete object may follow.
          }
          start = -1;
          inString = false;
          escaped = false;
        }
      }
    }

    if (candidates.length === 0) throw originalError;
    console.warn(candidates.length > 1
      ? `⚠️ Found ${candidates.length} puzzle JSON objects; using the final complete one.`
      : "⚠️ Ignored extra model text around puzzle JSON.");
    return candidates.at(-1);
  }
}

function sanitizePuzzle(puzzle) {
  if (!puzzle || typeof puzzle !== "object" || !Array.isArray(puzzle.close)) {
    return puzzle;
  }

  const receivedCloseCount = puzzle.close.length;
  const seen = new Set();
  const close = [];

  for (const value of puzzle.close) {
    if (typeof value !== "string") continue;

    const word = value.trim();
    const normalized = normalizeAnswer(word);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    close.push(word);

    if (close.length === MAX_CLOSE_WORDS) break;
  }

  if (receivedCloseCount !== close.length || receivedCloseCount < MIN_CLOSE_WORDS || receivedCloseCount > MAX_CLOSE_WORDS) {
    console.warn(`⚠️ Close words received: ${receivedCloseCount}; kept after cleanup: ${close.length}`);
  }

  return { ...puzzle, close };
}

function validatePuzzleShape(puzzle) {
  if (!puzzle || typeof puzzle !== "object") {
    throw new Error("Puzzle is not a JSON object");
  }

  if (typeof puzzle.answer !== "string" || !puzzle.answer.trim()) {
    throw new Error("Puzzle is missing a valid answer");
  }

  const answer = puzzle.answer.trim();
  if (!/^[A-Za-z][A-Za-z-]*$/.test(answer) || answer.includes(" ")) {
    throw new Error(`Answer must be a single word: ${answer}`);
  }

  if (typeof puzzle.partOfSpeech !== "string" || !ALLOWED_PARTS_OF_SPEECH.has(puzzle.partOfSpeech)) {
    throw new Error(`Puzzle partOfSpeech must be one of: ${Array.from(ALLOWED_PARTS_OF_SPEECH).join(", ")}`);
  }

  if (puzzle.partOfSpeech === "Gerund (noun)" && !answer.toLowerCase().endsWith("ing")) {
    throw new Error(`Gerund answer must end in -ing: ${answer}`);
  }

  if (!Array.isArray(puzzle.sentences) || puzzle.sentences.length !== 5) {
    throw new Error("Puzzle must contain exactly 5 sentences");
  }

  if (!Array.isArray(puzzle.close) || puzzle.close.length < MIN_CLOSE_WORDS || puzzle.close.length > MAX_CLOSE_WORDS) {
    throw new Error(`Puzzle close array must contain ${MIN_CLOSE_WORDS} to ${MAX_CLOSE_WORDS} words (received ${Array.isArray(puzzle.close) ? puzzle.close.length : "non-array"})`);
  }
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text.trim());
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

let archive = [];
try {
  archive = JSON.parse(fs.readFileSync("puzzles.json", "utf8"));
} catch {
  archive = [];
}

const usedAnswers = new Set(
  archive
    .map((puzzle) => normalizeAnswer(puzzle.answer))
    .filter(Boolean)
);

// Puzzle number: days since launch (March 6, 2026 in Denver time)
const LAUNCH_DATE = "2026-03-06";

// Each daily scheduled run fills any gaps from the current UTC date through
// three days ahead. The workflow invokes this script four times.
 // Explicit --id/--date overrides remain available for manual backfills.
const idArg = process.argv.find((arg) => arg.startsWith("--id="));
const dateArg = process.argv.find((arg) => arg.startsWith("--date="));

function shiftISODate(iso, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Invalid ISO date: ${iso}`);
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Invalid calendar date: ${iso}`);
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function puzzleIdForDate(iso) {
  return getPuzzleId(new Date(`${iso}T12:00:00Z`), LAUNCH_DATE);
}

function dateExists(iso) {
  const id = puzzleIdForDate(iso);
  return archive.some((item) => item.id === id || item.date === iso);
}

function refreshHtmlFallback() {
  const denverToday = getLocalDateString(new Date());
  // Undated historical puzzles remain available; hide future-dated entries.
  const current = archive
    .filter((item) => !/^\d{4}-\d{2}-\d{2}$/.test(item.date || "") || item.date <= denverToday)
    .sort((a, b) => b.id - a.id)[0];
  if (!current) return;
  const template = fs.readFileSync("template.html", "utf8");
  if (!template.includes("__PUZZLE_DATA__")) throw new Error("Missing puzzle data placeholder in template.html");
  const output = template.replace("__PUZZLE_DATA__", JSON.stringify(current));
  if (!fs.existsSync("gist.html") || fs.readFileSync("gist.html", "utf8") !== output) {
    fs.writeFileSync("gist.html", output);
    console.log(`📄 gist.html fallback now points to puzzle #${current.id}`);
  }
}

const utcToday = new Date().toISOString().slice(0, 10);
const BUFFER_DAYS_AHEAD = 3;
const bufferDates = Array.from(
  { length: BUFFER_DAYS_AHEAD + 1 },
  (_, days) => shiftISODate(utcToday, days)
);
const requestedId = idArg ? Number(idArg.slice("--id=".length)) : null;
if (requestedId !== null && (!Number.isInteger(requestedId) || requestedId < 1)) {
  throw new Error(`Invalid puzzle ID override: ${idArg}`);
}
const requestedDate = dateArg ? dateArg.slice("--date=".length) : null;
const TARGET_ISO = requestedDate ||
  (requestedId !== null ? shiftISODate(LAUNCH_DATE, requestedId - 1) :
    bufferDates.find((date) => !dateExists(date)));
if (!TARGET_ISO) {
  console.log(`✅ Three-day puzzle buffer complete through ${bufferDates.at(-1)}.`);
  refreshHtmlFallback();
  process.exit(0);
}
shiftISODate(TARGET_ISO, 0);

const NOW = new Date(`${TARGET_ISO}T12:00:00Z`);
const localParts = getLocalParts(NOW);
const TODAY_ISO = `${localParts.year}-${localParts.month}-${localParts.day}`;
const TODAY = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: TIME_ZONE,
}).format(NOW);
const PUZZLE_ID = requestedId ?? puzzleIdForDate(TODAY_ISO);

if (puzzleIdForDate(TODAY_ISO) !== PUZZLE_ID) {
  throw new Error(`Puzzle ID #${PUZZLE_ID} doesn't match ${TODAY_ISO}`);
}
if (dateExists(TODAY_ISO)) {
  console.log(`⏭️ Puzzle #${PUZZLE_ID} for ${TODAY_ISO} already exists. Skipping generation.`);
  refreshHtmlFallback();
  process.exit(0);
}

// Day of week in Denver (0 = Sunday, 1 = Monday ... 6 = Saturday)
const DOW = new Date(`${TODAY_ISO}T00:00:00Z`).getUTCDay();

// Difficulty ramp: Mon=easy, Tue=easy, Wed=medium, Thu=medium, Fri=hard, Sat=hard, Sun=wildcard
const DIFFICULTY_MAP = {
  0: { label: "WILDCARD", level: "wildcard" },
  1: { label: "EASY", level: "easy" },
  2: { label: "EASY", level: "easy" },
  3: { label: "MEDIUM", level: "medium" },
  4: { label: "MEDIUM", level: "medium" },
  5: { label: "HARD", level: "hard" },
  6: { label: "HARD", level: "hard" },
};

const DIFFICULTY = DIFFICULTY_MAP[DOW];

const DIFFICULTY_INSTRUCTIONS = {
  easy: `
DIFFICULTY: EASY
- Choose an ordinary word almost everyone knows and uses in everyday conversation; a common feeling, action, object, or experience is ideal
- Examples of the level of familiarity: sleep, laughter, hunger, embarrassment, boredom, jealousy, curiosity (examples only; do not reuse historical answers)
- Make it genuinely approachable: a typical player should have a fair chance by clue 2 or 3
- Sentence 1 can be intriguing but should be understandable without decoding elaborate metaphors
- Sentence 2 MUST include a specific, recognizable everyday situation or example that points toward the answer
- Use simple vocabulary and increasingly concrete clues; avoid overly poetic, technical, or philosophical descriptions`,

  medium: `
DIFFICULTY: MEDIUM
- Choose a familiar word or concept most adults would recognize and encounter in normal reading or conversation
- Avoid academic jargon, obscure literary words, rare dictionary terms, or specialist vocabulary; do not make unfamiliar vocabulary the challenge
- Examples of the intended familiarity: nostalgia, ambition, coincidence, forgiveness, momentum, compromise, reputation (examples only; do not reuse historical answers)
- Clue 1 may be indirect, but include an ordinary real-world situation by clue 3
- By clue 4, a thoughtful player should reasonably be able to identify the specific answer instead of several equally plausible synonyms
- Aim for a fair solve in 3-4 guesses`,

  hard: `
DIFFICULTY: HARD
- Choose a nuanced, challenging word that is still recognizable to a general adult audience; difficulty should come from inference, not from an unknown technical term
- Sentence 1 can be cryptic but must have a meaningful connection to the answer
- Build toward concrete, distinguishing evidence, not just increasingly elaborate metaphors
- Clues 4 and 5 MUST include a defining characteristic, contrast, or recognizable situation that distinguishes the answer from likely near-synonyms
- Avoid puzzles where several common answers remain equally valid even after the final clue
- A thoughtful player should have a realistic chance by clue 5, even if clues 1-3 are difficult`,

  wildcard: `
DIFFICULTY: WILDCARD (Sunday)
- Surprise players with an unexpected subject or everyday phenomenon; it should feel fresh and fun, not like an obscure vocabulary exam
- Choose a recognizable answer word, even when the clues involve an interesting field such as cooking, weather, architecture, music, or science
- Avoid specialist terminology that would normally require formal training or a dictionary to identify
- Connect the topic to an accessible real-life example by clue 3, and make the answer clearly distinguishable by clue 5
- Vary the challenge between easy and medium most Sundays; keep occasional harder Sundays fair and solvable`,
};

const allUsedAnswers = Array.from(usedAnswers).sort();
const usedAnswersBlock = allUsedAnswers.length
  ? `\nDo NOT use any of these answers. They have already been used in prior GIST puzzles:\n${allUsedAnswers.join(", ")}\n`
  : "";

function buildPrompt({ rejectedAnswers = [] } = {}) {
  const rejectedBlock = rejectedAnswers.length
    ? `\nPreviously rejected answers in this run (do NOT use any of them again):\n${rejectedAnswers.join(", ")}\n`
    : "";

  return `Today is ${TODAY}. You are generating puzzle #${PUZZLE_ID} for GIST, a daily word game.

In GIST, a paragraph is revealed one sentence at a time. Players guess the ONE WORD that captures its essence. Each wrong guess reveals one more sentence of the paragraph as a clue. There are 5 sentences total, revealed one by one.

${DIFFICULTY_INSTRUCTIONS[DIFFICULTY.level]}
${usedAnswersBlock}${rejectedBlock}
Your job: create a puzzle. Choose a concept, emotion, phenomenon, action, or everyday object as the answer word. Write a clear, engaging 5-sentence paragraph that describes it without ever saying the word. Favor the satisfaction of recognizing a specific answer over impressively abstract prose. Elegant language is welcome, but fairness and clarity come first.

Rules:
- The answer must be a single English word (not a proper noun, not a phrase)
- Include "partOfSpeech" for the exact intended grammatical form of the answer. Use exactly one of: "Noun (singular)", "Noun (plural)", "Gerund (noun)", "Verb", "Verb (infinitive)", "Verb (present participle)", "Verb (past participle)", "Adjective", "Adverb"
- Every noun MUST specify number: use "Noun (singular)" for singular or mass/uncountable nouns, and "Noun (plural)" for plural nouns
- The part of speech must match how the answer itself is intended. For an -ing answer naming an activity or process as a noun, use "Gerund (noun)" (e.g. "Planning takes time"). For an -ing verb indicating an ongoing action, use "Verb (present participle)" (e.g. "They are planning"). An ordinary lexical noun ending in -ing that is not acting as a gerund may still use "Noun (singular)" or "Noun (plural)" as appropriate.
- Do not use "Gerund (noun)" for an answer that does not end in -ing; choose a different allowed part of speech instead.
- The answer must be different from every prior GIST answer listed above
- The paragraph must NOT contain the answer word or obvious synonyms
- Sentence 1 should be the most indirect clue, but still understandable rather than intentionally vague
- Each following sentence must add genuinely new information and progressively narrow the possibilities
- The final two clues should make the intended answer distinguishable from plausible near-synonyms; do not rely on subjective or generic descriptions
- Sentence 5 should be the most revealing, with an unambiguous real-world example or defining characteristic (without saying the answer)
- Limit abstract metaphors; use concrete examples and natural language instead of repeated phrases like "invisible architecture" or "the space between"
- Do not make Latin/Greek roots, historical etymology, or a technical definition the only revealing part of the final clue
- The paragraph should feel precise, vivid, and fair to a general audience — not like a riddle or a vocabulary test
- Also provide 3-10 "close" words that are near-synonyms or useful word-form variations (a player guessing these gets a yellow result)
- The "close" array MUST include common variations of the answer word (verb forms, plural, adjective forms, past tense, etc.) — for example if the answer is "anticipation" include "anticipate", "anticipating", "anticipated"

Return ONLY valid JSON, no markdown, exactly this format:
{
  "answer": "loneliness",
  "partOfSpeech": "Noun (singular)",
  "difficulty": "EASY",
  "sentences": [
    "A room can be full of people and still feel strangely empty.",
    "When a close friend moves away, even familiar places may feel different without them.",
    "It is not the same as being alone, because you can enjoy time by yourself and still feel connected.",
    "Calls and messages may help, but they cannot always replace feeling understood or having someone nearby.",
    "It is the painful feeling of wanting companionship or connection and finding it missing."
  ],
  "close": ["isolation", "solitude", "alienation", "emptiness"]
}

Set "difficulty" in the JSON to exactly: "${DIFFICULTY.label}"`;
}

console.log(`🧩 Generating GIST puzzle #${PUZZLE_ID} [${DIFFICULTY.label} — ${TODAY} / ${TIME_ZONE}]...`);

let puzzle;
const rejectedAnswers = [];

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  try {
    console.log(`🔁 Attempt ${attempt}/${MAX_ATTEMPTS}`);
    const raw = await callClaude(buildPrompt({ rejectedAnswers }));
    const candidate = sanitizePuzzle(parsePuzzleJson(raw));
    validatePuzzleShape(candidate);

    const normalized = normalizeAnswer(candidate.answer);
    if (!normalized) {
      throw new Error("Answer normalized to an empty value");
    }

    if (usedAnswers.has(normalized)) {
      throw new Error(`Duplicate historical answer: ${candidate.answer}`);
    }

    if (rejectedAnswers.includes(normalized)) {
      throw new Error(`Duplicate answer within retry loop: ${candidate.answer}`);
    }

    puzzle = candidate;
    break;
  } catch (error) {
    const duplicateMatch = String(error.message || "").match(/Duplicate (?:historical answer|answer within retry loop):\s*(.+)$/);
    if (duplicateMatch) {
      const rejected = normalizeAnswer(duplicateMatch[1]);
      if (rejected && !rejectedAnswers.includes(rejected)) rejectedAnswers.push(rejected);
    }

    if (error.message?.startsWith("Answer must be a single word:")) {
      const invalid = normalizeAnswer(error.message.replace("Answer must be a single word:", ""));
      if (invalid && !rejectedAnswers.includes(invalid)) rejectedAnswers.push(invalid);
    }

    console.warn(`⚠️ Attempt ${attempt} failed: ${error.message}`);
    if (attempt === MAX_ATTEMPTS) {
      console.error(`❌ Failed to generate a unique puzzle after ${MAX_ATTEMPTS} attempts.`);
      process.exit(1);
    }
  }
}

puzzle.id = PUZZLE_ID;
puzzle.date = TODAY_ISO;
puzzle.difficulty = DIFFICULTY.label;
console.log(`✅ Answer: "${puzzle.answer}" [${puzzle.partOfSpeech}; ${puzzle.difficulty}; ${puzzle.date}]`);
console.log(`📝 Sentences: ${puzzle.sentences.length}`);

// Add new dated puzzles without modifying historical entries.
archive.push(puzzle);
archive.sort((a, b) => b.id - a.id);
fs.writeFileSync("puzzles.json", JSON.stringify(archive, null, 2));
console.log(`📚 puzzles.json updated (${archive.length} puzzles total)`);

// The static HTML fallback must not contain an unpublished future puzzle.
refreshHtmlFallback();
