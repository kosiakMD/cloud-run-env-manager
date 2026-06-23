/**
 * Shared size tokens for every interactive control in the header,
 * filter toolbar and services row. The goal is one obvious place to
 * tweak the chrome instead of chasing tiny height differences across a
 * dozen component files — that's the bug that produced "Light is taller
 * than +" and "checkbox rows overlap".
 *
 * Conventions:
 *   - `PILL`        — the standard chip / button / input size.
 *                     mobile 36px (matches Sign-out, ProjectSelector
 *                     trigger, ThemeToggle on a phone),
 *                     desktop 28px (compact pointer-precision strip).
 *   - `PILL_SMALL`  — secondary controls like Refresh; one step shorter.
 *   - `PILL_TEXT`   — font sizing kept in lockstep with the height so a
 *                     mobile pill never reads as a desktop chip.
 *
 * Every consumer applies these via string interpolation; no Tailwind
 * arbitrary-value tricks needed, JIT picks them up because they're
 * literal class names.
 */

export const PILL_H = 'h-9 lg:h-7';
export const PILL_TEXT = 'text-sm lg:text-xs';
export const PILL_PAD = 'px-3 lg:px-2';

/** Standard pill — chips, +, ServiceTabs, ThemeToggle, Sign out, Add, Import, ALL/DIFF/GAP. */
export const PILL = `${PILL_H} ${PILL_PAD} inline-flex items-center rounded ${PILL_TEXT}`;

/** Slightly shorter secondary pill — Refresh, project selector trigger. */
export const PILL_SMALL_H = 'h-8 lg:h-6';
export const PILL_SMALL = `${PILL_SMALL_H} ${PILL_PAD} inline-flex items-center rounded ${PILL_TEXT}`;

/** Search input + any other text input that should sit next to PILL controls. */
export const INPUT = `${PILL_H} ${PILL_PAD} ${PILL_TEXT} border rounded bg-white dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100`;
