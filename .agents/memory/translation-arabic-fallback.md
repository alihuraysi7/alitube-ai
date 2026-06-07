---
name: Translation silent-English fallback
description: Why EN→AR subtitles/dubbing can silently turn English, and the rule that prevents it
---

# Translation silent-English fallback

The app translates EN→AR using two free, key-less APIs: MyMemory and the unofficial
Google Translate endpoint. Both can hiccup, rate-limit, or block a datacenter IP
(notably on the deployed app) while working fine in dev.

**Failure mode:** on any API error the translators used to silently fall back to the
*original English* text, and the YouTube `/translate` route then **cached** that
English permanently — so every later run served stale English. Dubbing reads the
translated text field, so English subtitles ⇒ English dubbing. One root cause.

**Rules (keep these):**
- Never treat a translation as success without validating it actually contains Arabic
  (`/[\u0600-\u06FF]/`). An API that echoes English or returns an error string must
  count as a failure and trigger fallback.
- Always try the *other* engine before giving up to original text.
- **Never cache a translation that had any failed line.** Caching English fallback is
  what makes the regression permanent.
- Log every fallback (`req.log.warn`) — silent fallback made this undiagnosable.

**Why:** code being correct in dev does not mean the free APIs work from the deployed
IP; the durable fix is validation + cross-engine fallback + don't-cache-failures, not
trusting a single engine.

**How to apply:** any change to translation in `artifacts/api-server/src/routes/translate.ts`
(YouTube) or `whisper.ts` (uploads) must preserve these four rules.
