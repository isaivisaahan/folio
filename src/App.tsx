import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';
import {
  BookOpen, Bookmark, Check, ChevronLeft, ChevronRight, FilePlus2,
  Highlighter, LibraryBig, ListFilter, Maximize2, Minimize2, Moon,
  MoreHorizontal, NotebookPen, Search, Sun, Trash2, Upload, X, ZoomIn, ZoomOut,
  Download, Rows3, FileText, Eye, EyeOff, BookA, Copy, Volume2, Loader2, ExternalLink
} from 'lucide-react';
import { db, makeId, type Book, type Bookmark as BookMark, type Note } from './db';

type Theme = 'paper' | 'sepia' | 'night';
type ScrollMode = 'single' | 'continuous';

const APK_DOWNLOAD_URL = 'https://github.com/isaivisaahan/folio/releases/download/v0.1.0/app-debug.apk';

interface DictDefinition {
  definition: string;
  example?: string;
}

interface DictMeaning {
  partOfSpeech: string;
  definitions: DictDefinition[];
}

interface DictResult {
  word: string;
  phonetic?: string;
  audio?: string;
  meanings: DictMeaning[];
}

const coverColors = ['#d7e1d5', '#ead8c5', '#d7dce8', '#e8d5d7', '#d9e2e5', '#e9e3cb'];
const fmtSize = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
const shortDate = (n: number) => new Date(n).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// =========================================================================
// RESILIENT MULTI-TIER DICTIONARY RESOLVER
// =========================================================================
async function fetchWordDefinition(rawWord: string): Promise<DictResult | null> {
  const cleanWord = rawWord.replace(/[^a-zA-Z'-]/g, '').toLowerCase();
  if (!cleanWord) return null;

  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        const phonetic = item.phonetic || item.phonetics?.find((p: any) => p.text)?.text;
        const audio = item.phonetics?.find((p: any) => p.audio && p.audio.trim().length > 0)?.audio;
        return {
          word: item.word || cleanWord,
          phonetic,
          audio,
          meanings: item.meanings || []
        };
      }
    }
  } catch {
    // Proceed to Datamuse fallback
  }

  try {
    const res = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(cleanWord)}&md=dp&max=1`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0].defs) && data[0].defs.length > 0) {
        const item = data[0];
        const posMap: Record<string, string> = {
          n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb',
          prep: 'preposition', pron: 'pronoun', conj: 'conjunction', interj: 'interjection'
        };

        const grouped: Record<string, DictDefinition[]> = {};
        for (const defItem of item.defs) {
          const parts = defItem.split('\t');
          const pos = posMap[parts[0]] || parts[0] || 'general';
          const definition = parts[1] || parts[0];
          if (!grouped[pos]) grouped[pos] = [];
          grouped[pos].push({ definition });
        }

        const meanings: DictMeaning[] = Object.entries(grouped).map(([partOfSpeech, definitions]) => ({
          partOfSpeech,
          definitions
        }));

        return { word: item.word || cleanWord, meanings };
      }
    }
  } catch {
    // Proceed to Wiktionary fallback
  }

  try {
    const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(cleanWord)}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.en && Array.isArray(data.en) && data.en.length > 0) {
        const meanings: DictMeaning[] = data.en.map((section: any) => ({
          partOfSpeech: section.partOfSpeech || 'general',
          definitions: (section.definitions || []).map((d: any) => ({
            definition: (d.definition || '').replace(/<[^>]+>/g, '').trim(),
            example: d.examples && d.examples[0] ? d.examples[0].replace(/<[^>]+>/g, '').trim() : undefined
          })).filter((d: any) => d.definition.length > 0)
        })).filter((m: any) => m.definitions.length > 0);

        if (meanings.length > 0) {
          return { word: cleanWord, meanings };
        }
      }
    }
  } catch {
    // Handled in caller
  }

  return null;
}

export default function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [active, setActive] = useState<Book | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const pdfFile = useMemo(() => pdfData ? { data: pdfData } : null, [pdfData]);
  const [pdfPreparing, setPdfPreparing] = useState(false);
  const [theme, setTheme] = useState<Theme>('paper');
  const [scrollMode, setScrollMode] = useState<ScrollMode>('single');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'library' | 'notes'>('library');
  const [bookmarks, setBookmarks] = useState<BookMark[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedText, setSelectedText] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [highlightColor, setHighlightColor] = useState('#f6d978');
  const [showNotes, setShowNotes] = useState(false);
  const [showContents, setShowContents] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [sort, setSort] = useState<'recent' | 'title' | 'added'>('recent');
  const [importing, setImporting] = useState(false);

  // Curl Turn & Brightness states
  const [turnDirection, setTurnDirection] = useState<'next' | 'prev' | null>(null);
  const [brightness, setBrightness] = useState<number>(1.0);
  const [showBrightnessHud, setShowBrightnessHud] = useState<boolean>(false);
  const hudTimerRef = useRef<number | null>(null);

  // Selection Popover & Dictionary states
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null);
  const [dictWord, setDictWord] = useState('');
  const [dictResult, setDictResult] = useState<DictResult | null>(null);
  const [dictLoading, setDictLoading] = useState(false);
  const [showDictModal, setShowDictModal] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const transformLayerRef = useRef<HTMLDivElement>(null);

  const singleTapRef = useRef<{ x: number; y: number; time: number; hasMoved: boolean }>({
    x: 0, y: 0, time: 0, hasMoved: false
  });

  const twoFingerRef = useRef<{
    active: 'none' | 'deciding' | 'pinch' | 'brightness';
    startDist: number;
    startCenterY: number;
    startZoom: number;
    startBrightness: number;
    scaleRatio: number;
  }>({
    active: 'none', startDist: 0, startCenterY: 0, startZoom: 1, startBrightness: 1, scaleRatio: 1
  });

  const refresh = async () => {
    const [b, bm, ns] = await Promise.all([db.books.toArray(), db.bookmarks.toArray(), db.notes.toArray()]);
    setBooks(b); setBookmarks(bm); setNotes(ns);
  };

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPdfData(null);
    if (!active) { setPdfPreparing(false); return; }
    setPdfPreparing(true);
    (async () => {
      try {
        const blob = active.file instanceof Blob ? active.file : null;
        if (!blob) throw new Error('The saved book record has no readable PDF Blob.');
        const buffer = await blob.arrayBuffer();
        if (!buffer.byteLength) throw new Error('The saved PDF file is empty.');
        if (!cancelled) setPdfData(new Uint8Array(buffer));
      } catch (error) {
        console.error('Folio could not read the saved PDF:', error);
        if (!cancelled) setToast(error instanceof Error ? error.message : 'Could not read the saved PDF file.');
      } finally { if (!cancelled) setPdfPreparing(false); }
    })();
    return () => { cancelled = true; };
  }, [active?.id]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const visibleBooks = useMemo(() => {
    let list = books.filter(b => `${b.title} ${b.fileName}`.toLowerCase().includes(query.toLowerCase()));
    if (sort === 'title') list = list.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'added') list = list.sort((a, b) => b.addedAt - a.addedAt);
    else list = list.sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
    return list;
  }, [books, query, sort]);

  const importFiles = async (files: FileList | File[]) => {
    const pdfs = Array.from(files).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) { setToast('Choose one or more PDF files.'); return; }
    setImporting(true);
    try {
      for (const file of pdfs) {
        const exists = await db.books.filter(b => b.fileName === file.name && b.size === file.size).first();
        if (exists) continue;
        const title = file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'Untitled book';
        await db.books.add({
          id: makeId(),
          title,
          fileName: file.name,
          size: file.size,
          addedAt: Date.now(),
          file,
          lastPage: 1,
          progress: 0,
          coverColor: coverColors[Math.floor(Math.random() * coverColors.length)]
        });
      }
      await refresh();
      setToast(`${pdfs.length} PDF${pdfs.length === 1 ? '' : 's'} added to your library.`);
    } catch {
      setToast('Could not save these files. Check available browser storage.');
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const openBook = async (book: Book) => {
    setLoading(true);
    setActive(book);
    setPage(book.lastPage || 1);
    setPageCount(book.pageCount || 0);
    setZoom(1);
    setSelectedText('');
    setPopoverPos(null);
    setShowNotes(false);
    setShowContents(false);
    setFocusMode(false);
    await db.books.update(book.id, { lastOpened: Date.now() });
    await refresh();
    setLoading(false);
  };

  const closeBook = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setActive(null);
    setSelectedText('');
    setPopoverPos(null);
    setFocusMode(false);
    void refresh();
  };

  const updateProgress = async (p: number, total: number) => {
    if (!active) return;
    const progress = total > 0 ? Math.round((p / total) * 100) : 0;
    await db.books.update(active.id, { lastPage: p, pageCount: total || active.pageCount, progress, lastOpened: Date.now() });
    setActive(prev => prev ? { ...prev, lastPage: p, pageCount: total || prev.pageCount, progress } : prev);
    setBooks(prev => prev.map(b => b.id === active.id ? { ...b, lastPage: p, pageCount: total || b.pageCount, progress, lastOpened: Date.now() } : b));
  };

  const animatedCurlJump = (targetPage: number, dir: 'next' | 'prev') => {
    if (scrollMode === 'continuous') {
      jump(targetPage);
      return;
    }
    const next = Math.min(Math.max(1, targetPage), pageCount || 1);
    if (next === page) return;

    setTurnDirection(dir);
    setPopoverPos(null);
    window.setTimeout(() => {
      setPage(next);
      void updateProgress(next, pageCount);
      setTurnDirection(null);
      readerRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    }, 320);
  };

  const jump = (p: number) => {
    const next = Math.min(Math.max(1, p), pageCount || 1);
    setPage(next);
    void updateProgress(next, pageCount);
    setPopoverPos(null);

    if (scrollMode === 'continuous') {
      const el = document.getElementById(`folio-page-${next}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      readerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const toggleFocusMode = () => {
    setFocusMode(prev => {
      const next = !prev;
      if (next) setToast('Focus mode on · Tap screen or top button to show controls');
      return next;
    });
    if (showNotes || showContents) {
      setShowNotes(false);
      setShowContents(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!active || showNotes || showDictModal) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (!pageCount || page < pageCount) animatedCurlJump(page + 1, 'next');
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (page > 1) animatedCurlJump(page - 1, 'prev');
      } else if (e.key === 'Escape') {
        if (showDictModal) setShowDictModal(false);
        else if (focusMode) setFocusMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, page, pageCount, showNotes, scrollMode, focusMode, showDictModal]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      setToast('Fullscreen toggle was blocked by the browser.');
    }
  };

  // Text Selection Check
  const checkSelection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!text || sel?.rangeCount === 0) {
      setPopoverPos(null);
      return;
    }

    setSelectedText(text.slice(0, 4000));
    try {
      const range = sel!.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height) {
        const x = Math.max(130, Math.min(window.innerWidth - 130, rect.left + rect.width / 2));
        // Position comfortably above selection and clear of notch
        const y = Math.max(90, rect.top - 16);
        setPopoverPos({ x, y });
      }
    } catch {
      setPopoverPos(null);
    }
  };

  const quickHighlight = async (color: string) => {
    if (!active || !selectedText.trim()) return;
    await db.notes.add({
      id: makeId(),
      bookId: active.id,
      page,
      text: selectedText.trim(),
      note: '',
      color,
      createdAt: Date.now()
    });
    setPopoverPos(null);
    window.getSelection()?.removeAllRanges();
    await refresh();
    setToast('Highlight saved.');
  };

  const lookupDictionary = async () => {
    const words = selectedText.trim().split(/\s+/);
    const rawWord = words[0].replace(/[^a-zA-Z'-]/g, '').toLowerCase();

    if (!rawWord) {
      setToast('Select a word to look up its definition.');
      return;
    }

    setDictWord(rawWord);
    setDictLoading(true);
    setShowDictModal(true);
    setPopoverPos(null);

    const result = await fetchWordDefinition(rawWord);
    setDictResult(result);
    setDictLoading(false);
  };

  const playWordPronunciation = () => {
    if (dictResult?.audio) {
      const audioUrl = dictResult.audio.startsWith('//') ? `https:${dictResult.audio}` : dictResult.audio;
      const sound = new Audio(audioUrl);
      sound.play().catch(() => {
        speakNative(dictResult.word || dictWord);
      });
    } else {
      speakNative(dictResult?.word || dictWord);
    }
  };

  const speakNative = (text: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      window.speechSynthesis.speak(utterance);
    }
  };

  const copySelectedText = () => {
    if (selectedText) {
      navigator.clipboard.writeText(selectedText);
      setToast('Copied to clipboard.');
      setPopoverPos(null);
      window.getSelection()?.removeAllRanges();
    }
  };

  // =========================================================================
  // HARDWARE-ACCELERATED NATIVE TOUCH LISTENERS (FIXES ANDROID WEBVIEW PINCH)
  // =========================================================================
  useEffect(() => {
    const el = readerRef.current;
    if (!el || !active) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        singleTapRef.current = { x: t.clientX, y: t.clientY, time: Date.now(), hasMoved: false };
        twoFingerRef.current.active = 'none';
      } else if (e.touches.length === 2) {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const centerY = (t1.clientY + t2.clientY) / 2;
        const centerX = (t1.clientX + t2.clientX) / 2;

        if (transformLayerRef.current) {
          const rect = transformLayerRef.current.getBoundingClientRect();
          const originX = Math.round(centerX - rect.left);
          const originY = Math.round(centerY - rect.top);
          transformLayerRef.current.style.transformOrigin = `${originX}px ${originY}px`;
        }

        twoFingerRef.current = {
          active: 'deciding',
          startDist: Math.max(10, dist),
          startCenterY: centerY,
          startZoom: zoom,
          startBrightness: brightness,
          scaleRatio: 1
        };
        singleTapRef.current.hasMoved = true;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        const dx = Math.abs(t.clientX - singleTapRef.current.x);
        const dy = Math.abs(t.clientY - singleTapRef.current.y);
        if (dx > 12 || dy > 12) singleTapRef.current.hasMoved = true;
        return;
      }

      if (e.touches.length === 2) {
        // Prevent native WebView pinch-zoom conflict
        if (e.cancelable) e.preventDefault();

        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const currentCenterY = (t1.clientY + t2.clientY) / 2;
        const deltaDist = currentDist - twoFingerRef.current.startDist;
        const deltaY = currentCenterY - twoFingerRef.current.startCenterY;

        if (twoFingerRef.current.active === 'deciding') {
          if (Math.abs(deltaDist) > 10) {
            twoFingerRef.current.active = 'pinch';
          } else if (Math.abs(deltaY) > 22 && Math.abs(deltaDist) < 12) {
            twoFingerRef.current.active = 'brightness';
          }
        }

        if (twoFingerRef.current.active === 'pinch') {
          const ratio = currentDist / twoFingerRef.current.startDist;
          twoFingerRef.current.scaleRatio = ratio;
          if (transformLayerRef.current) {
            transformLayerRef.current.style.transform = `scale(${ratio})`;
            transformLayerRef.current.style.transition = 'none';
          }
        } else if (twoFingerRef.current.active === 'brightness') {
          const sensitivity = 0.0035;
          const newBright = Math.min(1.0, Math.max(0.15, +(twoFingerRef.current.startBrightness - deltaY * sensitivity).toFixed(2)));
          setBrightness(newBright);
          setShowBrightnessHud(true);

          if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
          hudTimerRef.current = window.setTimeout(() => setShowBrightnessHud(false), 1400);
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length === 1 && !singleTapRef.current.hasMoved) {
        const dt = Date.now() - singleTapRef.current.time;
        if (dt < 380) {
          const selection = window.getSelection()?.toString().trim();
          if (!selection) {
            const target = e.target as HTMLElement;
            if (!target.closest('button, input, textarea, select, .reader-sidepanel, .page-controls, .reader-topbar, .reader-footer, .selection-popover, .dictionary-card')) {
              toggleFocusMode();
            }
          }
        }
      }

      if (twoFingerRef.current.active === 'pinch') {
        const { startZoom, scaleRatio } = twoFingerRef.current;
        const finalZoom = Math.min(2.5, Math.max(0.6, +(startZoom * scaleRatio).toFixed(2)));

        if (transformLayerRef.current) {
          transformLayerRef.current.style.transform = 'none';
          transformLayerRef.current.style.transformOrigin = 'center top';
          transformLayerRef.current.style.transition = 'none';
        }

        setZoom(finalZoom);
      }

      twoFingerRef.current.active = 'none';
      window.setTimeout(checkSelection, 60);
    };

    // Suppress native Android selection context menu popup over our custom menu
    const onContextMenu = (e: Event) => {
      e.preventDefault();
      checkSelection();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('contextmenu', onContextMenu);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('contextmenu', onContextMenu);
    };
  }, [active, zoom, brightness, focusMode]);

  const handleStageClick = (e: React.MouseEvent) => {
    const selection = window.getSelection()?.toString().trim();
    if (selection) {
      checkSelection();
      return;
    }

    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, select, .reader-sidepanel, .page-controls, .reader-topbar, .reader-footer, .selection-popover, .dictionary-card')) {
      return;
    }
    toggleFocusMode();
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      setZoom(z => Math.min(2.5, Math.max(0.6, +(z - e.deltaY * 0.005).toFixed(2))));
    }
  };

  useEffect(() => {
    if (scrollMode !== 'continuous' || !pageCount) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find(entry => entry.isIntersecting);
        if (visible) {
          const pageNum = Number(visible.target.getAttribute('data-page-number'));
          if (pageNum && pageNum !== page) {
            setPage(pageNum);
            void updateProgress(pageNum, pageCount);
          }
        }
      },
      { root: readerRef.current, threshold: 0.3 }
    );

    for (let i = 1; i <= pageCount; i++) {
      const el = document.getElementById(`folio-page-${i}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [scrollMode, pageCount, page, active?.id]);

  const addBookmark = async () => {
    if (!active) return;
    const existing = await db.bookmarks.where({ bookId: active.id, page }).first();
    if (existing) { setToast('This page is already bookmarked.'); return; }
    await db.bookmarks.add({ id: makeId(), bookId: active.id, page, label: `Page ${page}`, createdAt: Date.now() });
    await refresh();
    setToast('Bookmark saved.');
  };

  const saveNote = async () => {
    if (!active || (!selectedText.trim() && !noteDraft.trim())) return;
    await db.notes.add({
      id: makeId(),
      bookId: active.id,
      page,
      text: selectedText.trim(),
      note: noteDraft.trim(),
      color: highlightColor,
      createdAt: Date.now()
    });
    setSelectedText('');
    setNoteDraft('');
    setPopoverPos(null);
    await refresh();
    setToast('Highlight and note saved.');
  };

  const deleteBook = async (book: Book) => {
    if (!window.confirm(`Remove “${book.title}” and its saved notes from this device?`)) return;
    await Promise.all([
      db.books.delete(book.id),
      db.bookmarks.where('bookId').equals(book.id).delete(),
      db.notes.where('bookId').equals(book.id).delete()
    ]);
    if (active?.id === book.id) setActive(null);
    await refresh();
    setToast('Book removed from this device.');
  };

  const exportBackup = async () => {
    const [b, bm, ns] = await Promise.all([db.books.toArray(), db.bookmarks.toArray(), db.notes.toArray()]);
    const payload = {
      app: 'Folio Reader',
      version: 1,
      exportedAt: new Date().toISOString(),
      books: b.map(({ file, ...rest }) => rest),
      bookmarks: bm,
      notes: ns
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `folio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setToast('Backup downloaded. Note: this backup contains notes and metadata, not the PDF files.');
  };

  const exportNotes = () => {
    const rows = notes.map(n => ({
      book: books.find(b => b.id === n.bookId)?.title ?? 'Removed book',
      page: n.page,
      highlight: n.text,
      note: n.note,
      date: new Date(n.createdAt).toISOString()
    }));
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'folio-notes.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Reader View
  if (active) {
    const activeNotes = notes.filter(n => n.bookId === active.id).sort((a, b) => b.createdAt - a.createdAt);
    const activeBookmarks = bookmarks.filter(b => b.bookId === active.id).sort((a, b) => a.page - b.page);

    return (
      <div className={`app reader-app theme-${theme} ${focusMode ? 'focus-mode' : ''}`}>
        <div
          className="reader-brightness-overlay"
          style={{ opacity: Math.max(0, 1 - brightness) }}
        />

        {focusMode && (
          <button
            className="focus-exit-pill"
            onClick={() => setFocusMode(false)}
            aria-label="Show reader controls"
          >
            <Eye size={13} />
            <span>Show controls</span>
          </button>
        )}

        {/* Floating Contextual Text Selection Bar */}
        {popoverPos && (
          <div
            className="selection-popover"
            style={{ left: `${popoverPos.x}px`, top: `${popoverPos.y}px` }}
            onClick={e => e.stopPropagation()}
          >
            <button className="popover-btn" onClick={lookupDictionary} title="Look up definition">
              <BookA size={14} />
              <span>Define</span>
            </button>
            <span className="popover-divider" />
            <div className="popover-colors">
              {['#f6d978', '#b9d9f5', '#bfe2c2', '#f1bfd1'].map(c => (
                <button
                  key={c}
                  className="popover-color-dot"
                  style={{ background: c }}
                  onClick={() => void quickHighlight(c)}
                  title={`Highlight in ${c}`}
                />
              ))}
            </div>
            <span className="popover-divider" />
            <button
              className="popover-btn"
              onClick={() => {
                setShowNotes(true);
                setPopoverPos(null);
              }}
              title="Add a custom note"
            >
              <NotebookPen size={14} />
              <span>Note</span>
            </button>
            <button className="popover-btn" onClick={copySelectedText} title="Copy selected text">
              <Copy size={14} />
            </button>
            <button className="popover-btn" onClick={() => setPopoverPos(null)} title="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Robust Multi-Tier Dictionary Modal */}
        {showDictModal && (
          <div className="dictionary-backdrop" onClick={() => setShowDictModal(false)}>
            <div className="dictionary-card" onClick={e => e.stopPropagation()}>
              <div className="dict-header">
                <div className="dict-word-row">
                  <h3>{dictResult?.word || dictWord}</h3>
                  {dictResult?.phonetic && <span className="dict-phonetic">{dictResult.phonetic}</span>}
                  <button
                    className="dict-audio-btn"
                    onClick={playWordPronunciation}
                    title="Pronounce word"
                  >
                    <Volume2 size={16} />
                  </button>
                </div>
                <button className="icon-btn" onClick={() => setShowDictModal(false)}>
                  <X size={18} />
                </button>
              </div>

              <div className="dict-body">
                {dictLoading ? (
                  <div className="loading-state" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    <Loader2 size={18} className="spin-icon" />
                    <span>Searching dictionary…</span>
                  </div>
                ) : dictResult && dictResult.meanings.length > 0 ? (
                  dictResult.meanings.map((m, idx) => (
                    <div className="dict-meaning-block" key={idx}>
                      <span className="dict-part-of-speech">{m.partOfSpeech.toUpperCase()}</span>
                      <ol className="dict-definitions-list">
                        {m.definitions.slice(0, 4).map((d, dIdx) => (
                          <li className="dict-definition-item" key={dIdx}>
                            <span>{d.definition}</span>
                            {d.example && <span className="dict-example">“{d.example}”</span>}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))
                ) : (
                  <div className="empty-small" style={{ padding: '20px 0', textAlign: 'center' }}>
                    <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600 }}>No online definition found for “{dictWord}”.</p>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
                      <a
                        href={`https://www.google.com/search?q=define+${encodeURIComponent(dictWord)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="secondary-btn"
                        style={{ fontSize: 11, padding: '6px 12px', textDecoration: 'none' }}
                      >
                        <ExternalLink size={13} />
                        <span>Search Google</span>
                      </a>
                      <a
                        href={`https://en.wiktionary.org/wiki/${encodeURIComponent(dictWord)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="secondary-btn"
                        style={{ fontSize: 11, padding: '6px 12px', textDecoration: 'none' }}
                      >
                        <BookOpen size={13} />
                        <span>Wiktionary</span>
                      </a>
                    </div>
                  </div>
                )}
              </div>

              <div className="dict-footer">
                <button
                  className="secondary-btn"
                  style={{ padding: '6px 12px', fontSize: 11 }}
                  onClick={() => {
                    void quickHighlight('#f6d978');
                    setShowDictModal(false);
                  }}
                >
                  <Highlighter size={13} />
                  <span>Highlight word</span>
                </button>
                <button
                  className="primary-btn small"
                  onClick={() => setShowDictModal(false)}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {showBrightnessHud && (
          <div className="brightness-hud">
            <Sun size={17} />
            <div className="brightness-hud-track">
              <div className="brightness-hud-fill" style={{ width: `${Math.round(brightness * 100)}%` }} />
            </div>
            <span className="brightness-hud-value">{Math.round(brightness * 100)}%</span>
          </div>
        )}

        {/* Reader Topbar */}
        <header className="reader-topbar">
          <button className="icon-btn" onClick={closeBook} aria-label="Back to library">
            <ChevronLeft />
          </button>
          <div className="reader-book-title">
            <span className="eyebrow" style={{ fontSize: 9, letterSpacing: 1.2, color: '#8a8d83' }}>NOW READING</span>
            <strong>{active.title}</strong>
          </div>
          <div className="reader-actions">
            <button
              className={`icon-btn ${scrollMode === 'continuous' ? 'active-mode' : ''}`}
              onClick={() => setScrollMode(m => m === 'single' ? 'continuous' : 'single')}
              title={scrollMode === 'single' ? 'Continuous scroll' : 'Page by page'}
            >
              {scrollMode === 'single' ? <Rows3 /> : <FileText />}
            </button>
            <button
              className={`icon-btn ${focusMode ? 'active-mode' : ''}`}
              onClick={toggleFocusMode}
              title={focusMode ? 'Exit Focus Mode' : 'Focus Mode (Hide bars)'}
            >
              {focusMode ? <EyeOff /> : <Eye />}
            </button>
            <button className="icon-btn" onClick={() => setShowContents(!showContents)} title="Bookmarks">
              <ListFilter />
            </button>
            <button className="icon-btn" onClick={() => setShowNotes(!showNotes)} title="Notes & highlights">
              <NotebookPen />
            </button>
            <button className="icon-btn" onClick={addBookmark} title="Bookmark this page">
              <Bookmark />
            </button>
            <button
              className="icon-btn"
              onClick={() => setTheme(theme === 'paper' ? 'sepia' : theme === 'sepia' ? 'night' : 'paper')}
              title={`Theme: ${theme.toUpperCase()}`}
            >
              {theme === 'night' ? <Moon /> : <Sun />}
            </button>
            <button className="icon-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>
              {isFullscreen ? <Minimize2 /> : <Maximize2 />}
            </button>
          </div>
        </header>

        <main className="reader-layout">
          <section
            className="page-stage"
            ref={readerRef}
            onClick={handleStageClick}
            onWheel={handleWheel}
          >
            {loading && <div className="loading-state">Opening your book…</div>}
            {pdfPreparing && <div className="loading-state">Preparing your saved PDF…</div>}

            <div className="stage-transform-layer" ref={transformLayerRef}>
              <Document
                file={pdfFile}
                onLoadSuccess={({ numPages }) => {
                  setPageCount(numPages);
                  void updateProgress(Math.min(active.lastPage || 1, numPages), numPages);
                }}
                onLoadError={(error) => {
                  console.error('Folio PDF.js load error:', error);
                  setToast(`PDF could not be opened: ${error.message || 'unknown error'}`);
                }}
                loading={<div className="loading-state">Preparing pages…</div>}
              >
                {scrollMode === 'single' ? (
                  <div className={`pdf-page-wrap ${turnDirection ? `turning-${turnDirection}` : ''}`}>
                    <div className="curl-fold-overlay" />
                    <Page
                      pageNumber={page}
                      scale={zoom}
                      renderTextLayer
                      renderAnnotationLayer={false}
                      loading={<div className="page-skeleton" />}
                    />
                  </div>
                ) : (
                  Array.from({ length: pageCount || 1 }, (_, i) => i + 1).map(p => {
                    const isNear = pageCount <= 12 || Math.abs(p - page) <= 3;
                    return (
                      <div
                        key={p}
                        id={`folio-page-${p}`}
                        data-page-number={p}
                        className="pdf-page-wrap"
                      >
                        {isNear ? (
                          <Page
                            pageNumber={p}
                            scale={zoom}
                            renderTextLayer
                            renderAnnotationLayer={false}
                            loading={<div className="page-skeleton" />}
                          />
                        ) : (
                          <div style={{ width: `${Math.min(window.innerWidth - 32, 600 * zoom)}px`, height: `${850 * zoom}px` }} />
                        )}
                      </div>
                    );
                  })
                )}
              </Document>
            </div>
          </section>

          {(showNotes || showContents) && (
            <aside className="reader-sidepanel">
              <div className="panel-head">
                <div>
                  <span className="eyebrow" style={{ fontSize: 9, letterSpacing: 1.2, color: '#8a8d83' }}>YOUR BOOK</span>
                  <h3>{showNotes ? 'Highlights & notes' : 'Navigate'}</h3>
                </div>
                <button className="icon-btn" onClick={() => { setShowNotes(false); setShowContents(false); }}>
                  <X />
                </button>
              </div>

              {showContents && (
                <>
                  <div className="panel-section-title">BOOKMARKS <span>{activeBookmarks.length}</span></div>
                  {activeBookmarks.length ? (
                    activeBookmarks.map(b => (
                      <button className="list-row" key={b.id} onClick={() => jump(b.page)}>
                        <Bookmark size={15} />
                        <span>{b.label}</span>
                        <ChevronRight size={15} />
                      </button>
                    ))
                  ) : (
                    <p className="empty-small">No bookmarks yet. Save a page with the bookmark icon.</p>
                  )}
                  <div className="panel-section-title">READING PROGRESS</div>
                  <div className="progress-card">
                    <div className="progress-line">
                      <span>Page {page} of {pageCount || '—'}</span>
                      <b>{active.progress}%</b>
                    </div>
                    <div className="progress-track"><span style={{ width: `${active.progress}%` }} /></div>
                  </div>
                </>
              )}

              {showNotes && (
                <>
                  <div className="note-composer">
                    <label>Selected text {selectedText ? '· ready to save' : '· select text on the page first'}</label>
                    {selectedText && <blockquote>{selectedText}</blockquote>}
                    <textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder="Add your own note…" rows={3} />
                    <div className="composer-footer">
                      <div className="color-options">
                        {['#f6d978', '#b9d9f5', '#bfe2c2', '#f1bfd1'].map(c => (
                          <button
                            key={c}
                            className={`color-dot ${highlightColor === c ? 'chosen' : ''}`}
                            style={{ background: c }}
                            onClick={() => setHighlightColor(c)}
                            aria-label={`Highlight color ${c}`}
                          />
                        ))}
                      </div>
                      <button className="primary-btn" style={{ padding: '7px 12px', fontSize: 11 }} onClick={saveNote} disabled={!selectedText.trim() && !noteDraft.trim()}>
                        <Highlighter size={14} /> Save
                      </button>
                    </div>
                  </div>
                  <div className="panel-section-title">SAVED ITEMS <span>{activeNotes.length}</span></div>
                  {activeNotes.length ? (
                    activeNotes.map(n => (
                      <article className="saved-note" key={n.id}>
                        <div className="saved-note-top">
                          <span className="page-pill" onClick={() => jump(n.page)}>Page {n.page}</span>
                          <button
                            className="mini-icon"
                            onClick={async () => { await db.notes.delete(n.id); await refresh(); }}
                            aria-label="Delete note"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {n.text && <blockquote style={{ borderColor: n.color, background: `${n.color}33` }}>{n.text}</blockquote>}
                        {n.note && <p>{n.note}</p>}
                      </article>
                    ))
                  ) : (
                    <p className="empty-small">Your highlights and notes will appear here.</p>
                  )}
                </>
              )}
            </aside>
          )}
        </main>

        {/* Stationary Floating Page Controls */}
        <div className="page-controls" onClick={e => e.stopPropagation()}>
          <button
            className="icon-btn"
            disabled={page <= 1}
            onClick={() => animatedCurlJump(page - 1, 'prev')}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </button>
          <div className="page-count">
            <input
              aria-label="Current page"
              value={page}
              onChange={e => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setPage(n);
              }}
              onBlur={() => jump(page)}
              onKeyDown={e => { if (e.key === 'Enter') jump(page); }}
            />
            <span>of {pageCount || '—'}</span>
          </div>
          <button
            className="icon-btn"
            disabled={!!pageCount && page >= pageCount}
            onClick={() => animatedCurlJump(page + 1, 'next')}
            aria-label="Next page"
          >
            <ChevronRight />
          </button>
          <span className="control-divider" />
          <button className="icon-btn" onClick={() => setZoom(z => Math.max(0.6, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">
            <ZoomOut />
          </button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button className="icon-btn" onClick={() => setZoom(z => Math.min(2.5, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">
            <ZoomIn />
          </button>
        </div>

        <footer className="reader-footer">
          <span><span className="status-dot" /> Saved on this device</span>
          <span>{active.progress}% read</span>
          <div className="footer-progress"><span style={{ width: `${active.progress}%` }} /></div>
        </footer>

        {toast && <div className="toast"><Check size={16} />{toast}</div>}
      </div>
    );
  }

  // Minimal Clean Library View
  const continueBooks = [...books].filter(b => b.progress > 0 && b.progress < 100).sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)).slice(0, 3);
  const noteBook = (id: string) => books.find(b => b.id === id)?.title ?? 'Book no longer in library';

  return (
    <div className="app theme-paper library-app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BookOpen size={20} /></div>
          <span>folio<span className="brand-period">.</span></span>
        </div>
        <div className="side-label">YOUR SPACE</div>
        <button className={`nav-item ${tab === 'library' ? 'active' : ''}`} onClick={() => setTab('library')}>
          <LibraryBig size={17} /> Library <span className="nav-count">{books.length}</span>
        </button>
        <button className={`nav-item ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          <NotebookPen size={17} /> Notebook <span className="nav-count">{notes.length}</span>
        </button>
        <div className="sidebar-bottom">
          <a
            href={APK_DOWNLOAD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="nav-item settings-nav"
            style={{ textDecoration: 'none', color: 'var(--green)', fontWeight: 600 }}
            title="Download Android APK directly"
          >
            <Download size={16} /> <span>Download Android APK</span>
          </a>
          <button className="nav-item settings-nav" onClick={exportBackup}>
            <Download size={16} /> Export backup
          </button>
          <button className="nav-item settings-nav" onClick={exportNotes}>
            <NotebookPen size={16} /> Export notes
          </button>
        </div>
      </aside>

      <main className="library-main">
        <header className="library-topbar">
          <div className="mobile-brand">
            <div className="brand-mark"><BookOpen size={18} /></div>
            <span>folio<span className="brand-period">.</span></span>
          </div>
          <div className="breadcrumbs">Personal library / <b>{tab === 'library' ? 'Books' : 'Notebook'}</b></div>
          <div className="topbar-right">
            <span className="offline-chip"><span className="status-dot" /> Offline ready</span>
            <button className="avatar-button" title="Local library">F</button>
          </div>
        </header>

        {tab === 'library' ? (
          <div className="library-content">
            <div className="library-header-row">
              <div className="library-title-group">
                <h1>Library</h1>
                <span className="count-badge">{books.length}</span>
              </div>

              <div className="library-actions-group">
                <div className="search-box">
                  <Search size={16} />
                  <input placeholder="Search library" value={query} onChange={e => setQuery(e.target.value)} />
                  {query && <button onClick={() => setQuery('')}><X size={14} /></button>}
                </div>
                <label className="sort-select">
                  <ListFilter size={15} />
                  <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} aria-label="Sort books">
                    <option value="recent">Recent</option>
                    <option value="added">Added</option>
                    <option value="title">A–Z</option>
                  </select>
                </label>
                <a
                  href={APK_DOWNLOAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="secondary-btn"
                  style={{ textDecoration: 'none', height: 38 }}
                  title="Download Android APK"
                >
                  <Download size={16} />
                  <span>Download APK</span>
                </a>
                <button className="primary-btn" onClick={() => inputRef.current?.click()} disabled={importing}>
                  <FilePlus2 size={16} />
                  <span>{importing ? 'Importing…' : 'Import'}</span>
                </button>
                <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={e => e.target.files && void importFiles(e.target.files)} />
              </div>
            </div>

            {continueBooks.length > 0 && !query && (
              <section className="continue-shelf">
                <div className="shelf-label">CONTINUE READING</div>
                <div className="continue-grid">
                  {continueBooks.map(b => (
                    <button className="continue-card" key={b.id} onClick={() => void openBook(b)}>
                      <div className="mini-cover" style={{ background: b.coverColor }}>
                        <BookOpen size={20} />
                        <span>FOLIO</span>
                      </div>
                      <div className="continue-info">
                        <strong>{b.title}</strong>
                        <span>Page {b.lastPage}{b.pageCount ? ` of ${b.pageCount}` : ''}</span>
                        <div className="progress-track"><span style={{ width: `${b.progress}%` }} /></div>
                      </div>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {visibleBooks.length ? (
              <div className="book-grid">
                {visibleBooks.map(b => (
                  <article className="book-card" key={b.id}>
                    <button className="book-cover-button" onClick={() => void openBook(b)} aria-label={`Open ${b.title}`}>
                      <div className="book-cover" style={{ background: b.coverColor }}>
                        <div className="cover-topline">FOLIO · PDF</div>
                        <BookOpen size={24} strokeWidth={1.4} />
                        <div className="cover-title">{b.title}</div>
                        <div className="cover-bottomline">{fmtSize(b.size)}</div>
                      </div>
                    </button>
                    <div className="book-meta">
                      <div className="book-title-row">
                        <button onClick={() => void openBook(b)} className="book-title">{b.title}</button>
                        <button className="mini-icon" onClick={() => void deleteBook(b)} aria-label={`Remove ${b.title}`}>
                          <MoreHorizontal size={16} />
                        </button>
                      </div>
                      <div className="book-progress-row">
                        <div className="progress-track"><span style={{ width: `${b.progress}%` }} /></div>
                        <span>{b.progress}%</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-library">
                <div className="empty-illustration"><BookOpen size={26} /></div>
                <h3>{query ? 'No books found' : 'Your library is empty'}</h3>
                <p>{query ? 'Try a different search query.' : 'Add your PDF files to start reading offline.'}</p>
                {!query && (
                  <button className="primary-btn" onClick={() => inputRef.current?.click()}>
                    <Upload size={16} /> Import PDF
                  </button>
                )}
              </div>
            )}

            <footer className="library-footer">
              <span>Folio Reader</span>
              <span>{books.length} books · {notes.length} notes</span>
            </footer>
          </div>
        ) : (
          <div className="notebook-content">
            <h1>Notebook</h1>
            <p className="welcome-copy">Highlights and notes from your reading.</p>
            <div className="notebook-toolbar">
              <span>{notes.length} saved items</span>
              <button className="secondary-btn" onClick={exportNotes} disabled={!notes.length}>
                <Download size={15} /> Export notes
              </button>
            </div>
            {notes.length ? (
              <div className="notebook-list">
                {[...notes].sort((a, b) => b.createdAt - a.createdAt).map(n => (
                  <article className="notebook-entry" key={n.id}>
                    <div className="note-color-bar" style={{ background: n.color }} />
                    <div className="notebook-entry-content">
                      <div className="notebook-entry-meta">
                        <strong>{noteBook(n.bookId)}</strong>
                        <button
                          className="text-link"
                          onClick={() => {
                            const b = books.find(x => x.id === n.bookId);
                            if (b) void openBook(b).then(() => { setShowNotes(true); setTimeout(() => jump(n.page), 150); });
                          }}
                        >
                          Page {n.page} <ChevronRight size={13} />
                        </button>
                      </div>
                      {n.text && <blockquote>{n.text}</blockquote>}
                      {n.note && <p>{n.note}</p>}
                      <span className="note-date">Saved {shortDate(n.createdAt)}</span>
                    </div>
                    <button
                      className="mini-icon"
                      onClick={async () => { await db.notes.delete(n.id); await refresh(); }}
                      aria-label="Delete note"
                    >
                      <Trash2 size={14} />
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-library">
                <div className="empty-illustration"><Highlighter size={26} /></div>
                <h3>Your notes will appear here</h3>
                <p>Select text inside any PDF to save highlights and personal notes.</p>
              </div>
            )}
          </div>
        )}
      </main>

      <nav className="mobile-nav">
        <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
          <LibraryBig size={18} /><span>Library</span>
        </button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
          <NotebookPen size={18} /><span>Notebook</span>
        </button>
        <button onClick={() => inputRef.current?.click()}>
          <FilePlus2 size={18} /><span>Import</span>
        </button>
      </nav>

      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}
