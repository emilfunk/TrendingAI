import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_REGISTRY } from './sources.ts';
import { HARVEST_SEQUENCE } from './harvesters/orchestrator.ts';
import { PLATFORM_PRIOR } from './classify-type.ts';
import type { Source } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Source-exhaustiveness contract (S20 — advisor-driven scaffolding).
 *
 * When a new `Source` variant is added, FOUR locations MUST be updated
 * in lockstep:
 *   1. `SOURCE_REGISTRY` in `src/sources.ts`
 *   2. `HARVEST_SEQUENCE` in `src/harvesters/orchestrator.ts`
 *   3. `PLATFORM_PRIOR` in `src/classify-type.ts`
 *   4. `sourceSection('<source>', all)` call in `src/render.ts`
 *   5. `harvest:<source>` script in `package.json`
 *
 * This test fails if any of those is missing — pre-emptive defense against
 * the "added a source variant but missed a slot" merge-error that 3 parallel
 * Engineer agents otherwise risk.
 *
 * The list of expected sources is generated from `SOURCE_REGISTRY` itself —
 * a Source variant that has no registry entry will surface as a TypeScript
 * error before this test ever runs, since `SOURCE_REGISTRY: Record<Source,...>`
 * is exhaustively typed.
 */
const ALL_SOURCES = Object.keys(SOURCE_REGISTRY) as Source[];

describe('source-exhaustiveness contract (S20)', () => {
  test('every Source variant has a HARVEST_SEQUENCE slot', () => {
    for (const s of ALL_SOURCES) {
      expect(HARVEST_SEQUENCE).toContain(s);
    }
  });

  test('HARVEST_SEQUENCE has no duplicates', () => {
    expect(new Set(HARVEST_SEQUENCE).size).toBe(HARVEST_SEQUENCE.length);
  });

  test('every Source variant has a PLATFORM_PRIOR entry', () => {
    for (const s of ALL_SOURCES) {
      expect(PLATFORM_PRIOR[s]).toBeDefined();
      expect(PLATFORM_PRIOR[s].length).toBeGreaterThan(0);
    }
  });

  test('every Source variant has a per-source render section call', () => {
    const renderTs = readFileSync(resolve(ROOT, 'src/render.ts'), 'utf8');
    for (const s of ALL_SOURCES) {
      expect(renderTs).toContain(`sourceSection('${s}',`);
    }
  });

  test('every Source variant has a package.json harvest script', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const s of ALL_SOURCES) {
      expect(scripts[`harvest:${s}`]).toBeDefined();
    }
  });
});
