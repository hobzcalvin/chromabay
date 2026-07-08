import { writable, get } from 'svelte/store';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import type { SerializedPattern } from '$lib/patternSerializer';

// Current patterns store - now just array of SerializedPattern
export const patterns = writable<SerializedPattern[]>([]);

// Currently selected pattern store
export const currentPattern = writable<SerializedPattern | null>(null);

// Store for the current pattern name being edited
export const currentPatternName = writable<string>('');

const PATTERNS_KEY = 'patterns';
const CURRENT_PATTERN_KEY = 'currentPattern';

// Web fallback storage for development
const webStorage = {
  async get(options: { key: string }): Promise<{ value: string | null }> {
    const value = localStorage.getItem(options.key);
    return { value };
  },
  
  async set(options: { key: string; value: string }): Promise<void> {
    localStorage.setItem(options.key, options.value);
  }
};

// Detect if we're in a web environment and Capacitor isn't available
const useWebFallback = Capacitor.getPlatform() === 'web';

// Storage abstraction
const storage = useWebFallback ? webStorage : Preferences;

// --- Cloud-sync identity (Phase 0) ---------------------------------------------------------
// Every pattern carries a stable id + a last-writer-wins updatedAt (epoch ms). Deletions leave
// a tombstone so they propagate to other clients and don't resurrect on the next pull. None of
// this ever reaches the device (the BLE serializer builds meta from scratch as name+output).
const TOMBSTONES_KEY = 'patternTombstones';
export type Tombstone = { id: string; ms: number };

function nowMs(): number { return Date.now(); }
function newId(): string {
  try { return crypto.randomUUID(); }
  catch { return 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
}
/** Ensure a pattern has an id + updatedAt. Returns true if it mutated. */
function ensureMeta(p: SerializedPattern): boolean {
  if (!p.meta) { (p as any).meta = { output: 1 }; }
  let changed = false;
  if (!p.meta.id) { p.meta.id = newId(); changed = true; }
  if (typeof p.meta.updatedAt !== 'number') { p.meta.updatedAt = nowMs(); changed = true; }
  return changed;
}

async function readStored(): Promise<SerializedPattern[]> {
  const { value } = await storage.get({ key: PATTERNS_KEY });
  return value ? JSON.parse(value) : [];
}
async function writeStored(list: SerializedPattern[]): Promise<void> {
  await storage.set({ key: PATTERNS_KEY, value: JSON.stringify(list) });
}

export async function getStoredPatterns(): Promise<SerializedPattern[]> { return readStored(); }
export async function getTombstones(): Promise<Tombstone[]> {
  const { value } = await storage.get({ key: TOMBSTONES_KEY });
  return value ? JSON.parse(value) : [];
}
async function saveTombstones(list: Tombstone[]): Promise<void> {
  await storage.set({ key: TOMBSTONES_KEY, value: JSON.stringify(list) });
}
/** Record a deletion so it syncs and won't be resurrected by a pull. */
async function addTombstone(id: string | undefined, ms: number): Promise<void> {
  if (!id) return;
  const tombs = await getTombstones();
  const existing = tombs.find(t => t.id === id);
  if (existing) existing.ms = Math.max(existing.ms, ms);
  else tombs.push({ id, ms });
  await saveTombstones(tombs);
}

/** Callback invoked (debounced by the sync layer) whenever the local library changes, so the
 *  cloud sync can push. Set by patternSync; no-op otherwise. Keeps the store dependency-free. */
export let onLibraryChanged: () => void = () => {};
export function setLibraryChangeHook(fn: () => void) { onLibraryChanged = fn; }

// Calculate seconds since 12:00AM April 19 2025
function getSecondsSinceApril19() {
  const april19 = new Date('2025-04-19T00:00:00.000Z');
  const now = new Date();
  return Math.floor((now.getTime() - april19.getTime()) / 1000);
}

// Create default pattern
function createDefaultPattern(): SerializedPattern {
  const seconds = getSecondsSinceApril19();
  const name = `My First Pattern ${seconds}`;
  return {
    nodes: [{ t: "rainbow", o: 1 }],
    meta: { output: 1, name, id: newId(), updatedAt: nowMs() }
  };
}

// Create new pattern with rainbow node (same as default)
export function createEmptyPattern(name?: string): SerializedPattern {
  if (!name) {
    const seconds = getSecondsSinceApril19();
    name = `My Pattern ${seconds}`;
  }
  return {
    nodes: [{ t: "rainbow", o: 1 }],
    meta: { output: 1, name, id: newId(), updatedAt: nowMs() }
  };
}

// Load patterns from preferences/localStorage
export async function loadPatterns() {
  try {
    const { value } = await storage.get({ key: PATTERNS_KEY });
    
    if (value) {
      const patternsData: SerializedPattern[] = JSON.parse(value);
      // Backfill sync identity on any pre-existing patterns, and persist if we minted anything.
      let migrated = false;
      for (const p of patternsData) if (ensureMeta(p)) migrated = true;
      if (migrated) await writeStored(patternsData);
      patterns.set(patternsData);
      
      // Load the saved current pattern name
      const savedCurrentPatternName = await loadCurrentPatternName();
      
      // Try to find and set the saved current pattern
      let patternToSet: SerializedPattern | null = null;
      
      if (savedCurrentPatternName && patternsData.length > 0) {
        // Look for the saved pattern
        patternToSet = patternsData.find(p => p.meta?.name === savedCurrentPatternName) || null;
        
        if (patternToSet) {
          currentPattern.set(patternToSet);
          currentPatternName.set(patternToSet.meta?.name || 'Unnamed Pattern');
          console.log('✅ Restored saved current pattern:', patternToSet.meta?.name);
        } else {
          console.log('⚠️ Saved current pattern no longer exists:', savedCurrentPatternName);
        }
      }
      
      // If no saved pattern was found or restored, default to first pattern
      if (!patternToSet && patternsData.length > 0) {
        patternToSet = patternsData[0];
        currentPattern.set(patternToSet);
        currentPatternName.set(patternToSet.meta?.name || 'Unnamed Pattern');
        // Save this as the new current pattern
        await saveCurrentPatternName(patternToSet.meta?.name || 'Unnamed Pattern');
        console.log('🎯 Set first pattern as current:', patternToSet.meta?.name);
      }
      
      console.log('✅ Loaded patterns:', patternsData.length, 'patterns from', useWebFallback ? 'localStorage' : 'Capacitor Preferences');
    } else {
      // No patterns exist, create the default one
      const defaultPattern = createDefaultPattern();
      await savePattern(defaultPattern);
      patterns.set([defaultPattern]);
      currentPattern.set(defaultPattern);
      currentPatternName.set(defaultPattern.meta?.name || 'Unnamed Pattern');
      // Save this as the current pattern
      await saveCurrentPatternName(defaultPattern.meta?.name || 'Unnamed Pattern');
      console.log('✅ Created default pattern:', defaultPattern.meta?.name);
    }
  } catch (error) {
    console.error('❌ Error loading patterns:', error);
    // Fallback to default pattern on error
    const defaultPattern = createDefaultPattern();
    patterns.set([defaultPattern]);
    currentPattern.set(defaultPattern);
    currentPatternName.set(defaultPattern.meta?.name || 'Unnamed Pattern');
    // Save this as the current pattern
    await saveCurrentPatternName(defaultPattern.meta?.name || 'Unnamed Pattern');
    console.log('🔄 Fallback to default pattern due to error');
  }
}

// Save a single pattern to the stored patterns
export async function savePattern(pattern: SerializedPattern) {
  try {
    ensureMeta(pattern);
    pattern.meta.updatedAt = nowMs(); // a save is a change → bump the LWW clock
    // Get current patterns
    const existingPatterns = await readStored();

    // Update or add the pattern (match by name for now)
    const patternName = pattern.meta?.name || 'Unnamed Pattern';
    const existingIndex = existingPatterns.findIndex(p => p.meta?.name === patternName);
    if (existingIndex >= 0) {
      existingPatterns[existingIndex] = pattern;
    } else {
      existingPatterns.push(pattern);
    }

    await writeStored(existingPatterns);
    patterns.set(existingPatterns);
    console.log('💾 Saved pattern:', patternName, 'to', useWebFallback ? 'localStorage' : 'Capacitor Preferences');
    onLibraryChanged();
  } catch (error) {
    console.error('❌ Error saving pattern:', error);
    throw error;
  }
}

// Simple function to get current pattern without type issues
function getCurrentPattern(): SerializedPattern | null {
  try {
    return get(currentPattern);
  } catch {
    return null;
  }
}

// Save the current pattern name to storage
async function saveCurrentPatternName(patternName: string) {
  try {
    await storage.set({ key: CURRENT_PATTERN_KEY, value: patternName });
  } catch (error) {
    console.error('❌ Error saving current pattern name:', error);
  }
}

// Load the current pattern name from storage
async function loadCurrentPatternName(): Promise<string | null> {
  try {
    const { value } = await storage.get({ key: CURRENT_PATTERN_KEY });
    return value;
  } catch (error) {
    console.error('❌ Error loading current pattern name:', error);
    return null;
  }
}

// Save current pattern with new serialized data
export async function saveCurrentPattern(serializedPattern: SerializedPattern, name?: string) {
  try {
    const current = getCurrentPattern();
    
    if (current) {
      const updatedPattern: SerializedPattern = {
        nodes: serializedPattern.nodes,
        meta: {
          output: serializedPattern.meta?.output ?? 1,
          name: name || current.meta?.name || 'Unnamed Pattern',
          id: current.meta?.id, // preserve identity across edits (savePattern mints if absent)
          updatedAt: current.meta?.updatedAt
        }
      };

      await savePattern(updatedPattern);
      currentPattern.set(updatedPattern);
      if (name) {
        currentPatternName.set(name);
        // Save the current pattern name to persist selection
        await saveCurrentPatternName(name);
      }
      
      // Mark pattern as clean after saving
      const { markPatternClean } = await import('$lib/flowStore');
      markPatternClean();
    }
  } catch (error) {
    console.error('❌ Error saving current pattern:', error);
    throw error;
  }
}

// Save As - create new pattern
export async function saveAsPattern(serializedPattern: SerializedPattern, name: string) {
  try {
    const newPattern: SerializedPattern = {
      nodes: serializedPattern.nodes,
      meta: {
        output: serializedPattern.meta?.output ?? 1,
        name
      }
    };
    
    await savePattern(newPattern);
    currentPattern.set(newPattern);
    currentPatternName.set(name);
    // Save the current pattern name to persist selection
    await saveCurrentPatternName(name);
  } catch (error) {
    console.error('❌ Error saving pattern as:', error);
    throw error;
  }
}

// Rename current pattern
export async function renameCurrentPattern(newName: string) {
  try {
    const current = getCurrentPattern();
    
    if (!current) return;
    
    const oldName = current.meta?.name || 'Unnamed Pattern';
    
    // Get current patterns
    const { value } = await storage.get({ key: PATTERNS_KEY });
    const existingPatterns: SerializedPattern[] = value ? JSON.parse(value) : [];
    
    // Find and update the pattern by old name
    const existingIndex = existingPatterns.findIndex(p => p.meta?.name === oldName);
    if (existingIndex >= 0) {
      const updatedPattern: SerializedPattern = {
        nodes: current.nodes,
        meta: {
          output: current.meta?.output ?? 1,
          name: newName,
          id: current.meta?.id ?? newId(),
          updatedAt: nowMs()
        }
      };

      existingPatterns[existingIndex] = updatedPattern;
      await writeStored(existingPatterns);

      // Update stores
      patterns.set(existingPatterns);
      currentPattern.set(updatedPattern);
      currentPatternName.set(newName);
      // Save the current pattern name to persist selection
      await saveCurrentPatternName(newName);
      console.log('✏️ Renamed pattern from:', oldName, 'to:', newName);
      onLibraryChanged();
    }
  } catch (error) {
    console.error('❌ Error renaming pattern:', error);
    throw error;
  }
}

// Delete current pattern
export async function deleteCurrentPattern() {
  try {
    const current = getCurrentPattern();
    
    if (!current) return;
    
    // Get current patterns
    const { value } = await storage.get({ key: PATTERNS_KEY });
    const existingPatterns: SerializedPattern[] = value ? JSON.parse(value) : [];
    
    // Remove the current pattern (match by name), tombstoning its id for sync.
    const currentName = current.meta?.name || 'Unnamed Pattern';
    for (const p of existingPatterns.filter(p => p.meta?.name === currentName)) await addTombstone(p.meta?.id, nowMs());
    const filteredPatterns = existingPatterns.filter(p => p.meta?.name !== currentName);

    // If no patterns left, create an empty one
    if (filteredPatterns.length === 0) {
      const emptyPattern = createEmptyPattern();
      filteredPatterns.push(emptyPattern);
    }

    await writeStored(filteredPatterns);

    // Update stores
    patterns.set(filteredPatterns);
    currentPattern.set(filteredPatterns[0]);
    currentPatternName.set(filteredPatterns[0].meta?.name || 'Unnamed Pattern');
    // Save the current pattern name to persist selection
    await saveCurrentPatternName(filteredPatterns[0].meta?.name || 'Unnamed Pattern');
    console.log('🗑️ Deleted pattern:', currentName);
    onLibraryChanged();
  } catch (error) {
    console.error('❌ Error deleting pattern:', error);
    throw error;
  }
}

// Switch to a different pattern
export async function switchToPattern(patternName: string) {
  try {
    const allPatterns = get(patterns);
    
    const pattern = allPatterns.find(p => p.meta?.name === patternName);
    if (pattern) {
      currentPattern.set(pattern);
      currentPatternName.set(pattern.meta?.name || 'Unnamed Pattern');
      // Save the current pattern name to persist selection
      await saveCurrentPatternName(pattern.meta?.name || 'Unnamed Pattern');
      console.log('🔄 Switched to pattern:', pattern.meta?.name);
    }
  } catch (error) {
    console.error('❌ Error switching pattern:', error);
    throw error;
  }
}

// Check if pattern name exists (for Save As validation)
export function patternNameExists(name: string): boolean {
  try {
    const allPatterns = get(patterns);
    return allPatterns.some(p => p.meta?.name === name);
  } catch {
    return false;
  }
}

// Delete a pattern by name (for patterns list page)
export async function deletePatternByName(patternName: string) {
  try {
    // Get current patterns
    const { value } = await storage.get({ key: PATTERNS_KEY });
    const existingPatterns: SerializedPattern[] = value ? JSON.parse(value) : [];
    
    // Remove the pattern by name, tombstoning its id for sync.
    for (const p of existingPatterns.filter(p => p.meta?.name === patternName)) await addTombstone(p.meta?.id, nowMs());
    const filteredPatterns = existingPatterns.filter(p => p.meta?.name !== patternName);

    // If no patterns left, create an empty one
    if (filteredPatterns.length === 0) {
      const emptyPattern = createEmptyPattern();
      filteredPatterns.push(emptyPattern);
    }

    await writeStored(filteredPatterns);

    // Update stores
    patterns.set(filteredPatterns);

    // If the deleted pattern was the current one, switch to the first pattern
    const current = getCurrentPattern();
    if (current && current.meta?.name === patternName) {
      currentPattern.set(filteredPatterns[0]);
      currentPatternName.set(filteredPatterns[0].meta?.name || 'Unnamed Pattern');
      // Save the current pattern name to persist selection
      await saveCurrentPatternName(filteredPatterns[0].meta?.name || 'Unnamed Pattern');
    }

    console.log('🗑️ Deleted pattern:', patternName);
    onLibraryChanged();
  } catch (error) {
    console.error('❌ Error deleting pattern by name:', error);
    throw error;
  }
}

/**
 * Merge remote library rows into the local store: last-writer-wins by `updated_ms`, honoring
 * tombstones (a `deleted` row removes the local copy and records a tombstone so it won't
 * resurrect). Called by the cloud-sync pull. Returns whether anything changed locally.
 */
export async function applyRemoteLibrary(
  remote: { id: string; name: string; blob: any; deleted: boolean; updated_ms: number }[]
): Promise<{ changed: boolean }> {
  const local = await readStored();
  const tombs = await getTombstones();
  const tombById = new Map(tombs.map((t) => [t.id, t]));
  let changed = false;

  for (const r of remote) {
    if (!r.id) continue;
    const idx = local.findIndex((p) => p.meta?.id === r.id);
    const lp = idx >= 0 ? local[idx] : undefined;
    const localMs = lp?.meta?.updatedAt ?? tombById.get(r.id)?.ms ?? -1;
    if (r.updated_ms <= localMs) continue; // local is newer or equal → keep it

    if (r.deleted) {
      if (idx >= 0) local.splice(idx, 1);
      const t = tombById.get(r.id);
      if (t) t.ms = r.updated_ms;
      else { const nt = { id: r.id, ms: r.updated_ms }; tombs.push(nt); tombById.set(r.id, nt); }
      changed = true;
    } else if (r.blob) {
      const p: SerializedPattern = {
        nodes: r.blob.nodes || [],
        meta: {
          ...(r.blob.meta || {}),
          name: r.name || r.blob.meta?.name || 'Unnamed Pattern',
          output: r.blob.meta?.output ?? 1,
          id: r.id,
          updatedAt: r.updated_ms,
        },
      };
      if (idx >= 0) local[idx] = p; else local.push(p);
      const ti = tombs.findIndex((t) => t.id === r.id);
      if (ti >= 0) { tombs.splice(ti, 1); tombById.delete(r.id); }
      changed = true;
    }
  }

  if (!changed) return { changed: false };

  if (local.length === 0) local.push(createEmptyPattern());
  await writeStored(local);
  await saveTombstones(tombs);
  patterns.set(local);

  // Keep the current selection valid (by id, else name, else fall back to the first).
  const cur = getCurrentPattern();
  const still = cur ? local.find((p) => (cur.meta?.id && p.meta?.id === cur.meta?.id) || p.meta?.name === cur.meta?.name) : undefined;
  const pick = still ?? local[0];
  currentPattern.set(pick);
  currentPatternName.set(pick.meta?.name || 'Unnamed Pattern');
  if (!still) await saveCurrentPatternName(pick.meta?.name || 'Unnamed Pattern');

  return { changed: true };
}