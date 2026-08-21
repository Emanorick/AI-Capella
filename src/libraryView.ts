import { parseMusicXML } from './musicxml';
import { readScoreFile } from './scoreFile';
import { isFirebaseConfigured } from './firebaseConfig';
import { escapeHtml } from './escapeHtml';

export interface SongEntry {
  id: string;
  title: string;
  url?: string; // built-in songs, fetched on demand
  xml?: string; // imported songs, already in memory
  imported?: boolean;
}

// import.meta.env.BASE_URL (not a bare "/...") since the app is served from a subpath on
// GitHub Pages (https://<user>.github.io/AI-Capella/) as well as from "/" in local dev.
const BUILTIN_SONGS: SongEntry[] = [
  { id: 'evening-rise', title: 'Evening Rise', url: `${import.meta.env.BASE_URL}evening-rise.musicxml` },
];
const ACCEPTED_EXTENSIONS = ['.musicxml', '.xml', '.mxl'];

// The Firebase SDK dominates the bundle but is only needed for the shared library, so
// library.ts/firebase.ts/pinGate.ts are loaded lazily -- the first paint (library view, built-in
// songs, the whole player) doesn't wait on it. One cached promise so every caller shares a load.
type LibraryModule = typeof import('./library');
let libraryModulePromise: Promise<LibraryModule> | null = null;
function loadLibraryModule(): Promise<LibraryModule> {
  return (libraryModulePromise ??= import('./library'));
}

export interface LibraryViewOptions {
  songListEl: HTMLUListElement;
  importBtn: HTMLButtonElement;
  importInput: HTMLInputElement;
  importStatusEl: HTMLDivElement;
  /** The whole library panel; drag-and-drop of score files is accepted anywhere on it. */
  libraryEl: HTMLElement;
  onSongChosen: (song: SongEntry) => void;
}

export interface LibraryView {
  /** Shows a status line under the import button (shared with import/deletion feedback). */
  setStatus(text: string, isError?: boolean): void;
}

/**
 * Owns the library sidebar: the song list (built-ins plus the shared Firestore library),
 * importing scores (file picker and drag-and-drop), and the lazy Firebase bootstrap.
 */
export function initLibraryView(opts: LibraryViewOptions): LibraryView {
  const { songListEl, importBtn, importInput, importStatusEl, libraryEl, onSongChosen } = opts;
  let importedSongs: SongEntry[] = [];

  function allSongs(): SongEntry[] {
    return [...BUILTIN_SONGS, ...importedSongs];
  }

  function setStatus(text: string, isError = false) {
    importStatusEl.textContent = text;
    importStatusEl.classList.toggle('error', isError);
  }

  function renderSongList() {
    songListEl.innerHTML = allSongs()
      .map(
        (s) => `
        <li data-id="${escapeHtml(s.id)}">
          <button class="song-btn">${escapeHtml(s.title)}</button>
          ${s.imported ? '<button class="song-delete-btn" title="Remove from library">&times;</button>' : ''}
        </li>`,
      )
      .join('');
  }
  renderSongList();

  songListEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const li = target.closest<HTMLElement>('li');
    const id = li?.getAttribute('data-id');
    if (!id) return;

    if (target.closest('.song-delete-btn')) {
      void removeImportedSong(id);
      return;
    }
    const song = allSongs().find((s) => s.id === id);
    if (song) onSongChosen(song);
  });

  async function removeImportedSong(id: string) {
    // No optimistic local removal: the shared onSnapshot listener updates `importedSongs` and
    // re-renders for every device (including this one) once Firestore reflects the delete.
    try {
      const { deleteImportedSong } = await loadLibraryModule();
      await deleteImportedSong(id);
    } catch (err) {
      setStatus(`Couldn't remove song: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  async function importFiles(files: FileList | File[]) {
    if (!isFirebaseConfigured) {
      setStatus('Shared library not configured yet.', true);
      return;
    }
    const list = Array.from(files).filter((f) => ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)));
    if (!list.length) {
      setStatus('Choose a .musicxml, .xml, or .mxl file.', true);
      return;
    }

    let lastImported: SongEntry | null = null;
    const { saveImportedSong } = await loadLibraryModule();
    for (const file of list) {
      try {
        const xml = await readScoreFile(file);
        const score = parseMusicXML(xml); // validates the file and gives us a title
        const title =
          score.title && score.title !== 'Untitled' ? score.title : file.name.replace(/\.(musicxml|xml|mxl)$/i, '');
        const id = await saveImportedSong({ title, xml });
        lastImported = { id, title, xml, imported: true };
        setStatus(`Imported "${title}" -- now available on every device.`);
      } catch (err) {
        setStatus(`Couldn't import ${file.name}: ${err instanceof Error ? err.message : 'invalid file'}`, true);
      }
    }
    // The onSnapshot listener will render the confirmed list; load the new song immediately
    // rather than waiting on that round trip.
    if (lastImported) onSongChosen(lastImported);
  }

  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    if (importInput.files?.length) void importFiles(importInput.files);
    importInput.value = '';
  });
  libraryEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    libraryEl.classList.add('drag-over');
  });
  libraryEl.addEventListener('dragleave', () => libraryEl.classList.remove('drag-over'));
  libraryEl.addEventListener('drop', (e) => {
    e.preventDefault();
    libraryEl.classList.remove('drag-over');
    if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files);
  });

  void (async () => {
    // The app opens on the library view; no song is auto-loaded.
    if (!isFirebaseConfigured) {
      importBtn.disabled = true;
      importBtn.title = 'Shared library not configured yet';
      return;
    }

    try {
      const [{ ensureSignedIn }, { ensureAccess }, { subscribeToSongs }] = await Promise.all([
        import('./firebase'),
        import('./pinGate'),
        loadLibraryModule(),
      ]);
      // Sign in first: verifyPin (inside ensureAccess) reads Firestore, and the security rules
      // require request.auth != null, so an unsigned-in read would just hang/get rejected.
      await ensureSignedIn();
      await ensureAccess(); // PIN gate; resolves immediately if already granted on this device
      subscribeToSongs(
        (songs) => {
          importedSongs = songs.map((s) => ({ id: s.id, title: s.title, xml: s.xml, imported: true }));
          renderSongList();
        },
        (err) => {
          setStatus(`Shared library unavailable: ${err instanceof Error ? err.message : String(err)}`, true);
        },
      );
    } catch (err) {
      setStatus(`Couldn't connect to the shared library: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  })();

  return { setStatus };
}
