import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';
import {
  BookOpen, Bookmark, Check, ChevronLeft, ChevronRight, FilePlus2, Files,
  Highlighter, LibraryBig, ListFilter, Maximize2, Minimize2, Moon,
  MoreHorizontal, NotebookPen, Search, Sun, Trash2, Upload, X, ZoomIn, ZoomOut,
  Download, Rows3, FileText, Eye, EyeOff
} from 'lucide-react';
import { db, makeId, type Book, type Bookmark as BookMark, type Note } from './db';

type Theme = 'paper' | 'sepia' | 'night';
type ScrollMode = 'single' | 'continuous';

const coverColors = ['#d7e1d5', '#ead8c5', '#d7dce8', '#e8d5d7', '#d9e2e5', '#e9e3cb'];
const fmtSize = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
const shortDate = (n: number) => new Date(n).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

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

  const inputRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const transformLayerRef = useRef<HTMLDivElement>(null);

  // Tablet 1-Tap & 2-Finger Tracking Refs
  const singleTapRef = useRef<{ x: number; y: number; time: number; hasMoved: boolean }>({
    x: 0,
    y: 0,
    time: 0,
    hasMoved: false
  });

  const twoFingerRef = useRef<{
    active: 'none' | 'deciding' | 'pinch' | 'brightness';
    startDist: number;
    startCenterY: number;
    startZoom: number;
    startBrightness: number;
  }>({
    active: 'none',
    startDist: 0,
    startCenterY: 0,
    startZoom: 1,
    startBrightness: 1
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

  // 3D Page Curl Turn on Navigation
  const animatedCurlJump = (targetPage: number, dir: 'next' | 'prev') => {
    if (scrollMode === 'continuous') {
      jump(targetPage);
      return;
    }
    const next = Math.min(Math.max(1, targetPage), pageCount || 1);
    if (next === page) return;

    setTurnDirection(dir);
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

    if (scrollMode === 'continuous') {
      const el = document.getElementById(`folio-page-${next}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      readerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!active || showNotes) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (!pageCount || page < pageCount) animatedCurlJump(page + 1, 'next');
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (page > 1) animatedCurlJump(page - 1, 'prev');
      } else if (e.key === 'Escape' && focusMode) {
        setFocusMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, page, pageCount, showNotes, scrollMode, focusMode]);

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

  // =========================================================================
  // TABLET TOUCH ENGINE:
  // 1 Finger: Native vertical scroll & 1-tap hide/show
  // 2 Fingers: Zoom & Brightness ONLY
  // =========================================================================
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      // 1-Finger touch start: Track for 1-Tap Toggle
      const t = e.touches[0];
      singleTapRef.current = {
        x: t.clientX,
        y: t.clientY,
        time: Date.now(),
        hasMoved: false
      };
      twoFingerRef.current.active = 'none';
    } else if (e.touches.length === 2) {
      // 2-Finger touch start: Prepare Zoom or Brightness
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const centerY = (t1.clientY + t2.clientY) / 2;

      twoFingerRef.current = {
        active: 'deciding',
        startDist: dist,
        startCenterY: centerY,
        startZoom: zoom,
        startBrightness: brightness
      };
      singleTapRef.current.hasMoved = true;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      // 1-Finger move: Let browser scroll naturally, mark as moved so tap won't fire
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - singleTapRef.current.x);
      const dy = Math.abs(t.clientY - singleTapRef.current.y);
      if (dx > 8 || dy > 8) {
        singleTapRef.current.hasMoved = true;
      }
      return;
    }

    // 2-Fingers move: ONLY Zoom & Brightness
    if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const currentCenterY = (t1.clientY + t2.clientY) / 2;

      const deltaDist = currentDist - twoFingerRef.current.startDist;
      const deltaY = currentCenterY - twoFingerRef.current.startCenterY;

      // Determine intent between Zoom and Brightness
      if (twoFingerRef.current.active === 'deciding') {
        if (Math.abs(deltaDist) > 18) {
          twoFingerRef.current.active = 'pinch';
        } else if (Math.abs(deltaY) > 18) {
          twoFingerRef.current.active = 'brightness';
        }
      }

      // 1. PINCH ZOOM (GPU Transform)
      if (twoFingerRef.current.active === 'pinch') {
        const scaleRatio = currentDist / twoFingerRef.current.startDist;
        if (transformLayerRef.current) {
          transformLayerRef.current.style.transform = `scale(${scaleRatio})`;
          transformLayerRef.current.style.transition = 'none';
        }
      }

      // 2. BRIGHTNESS (2-Finger Vertical Swipe)
      else if (twoFingerRef.current.active === 'brightness') {
        const sensitivity = 0.0035;
        const newBright = Math.min(1.0, Math.max(0.15, +(twoFingerRef.current.startBrightness - deltaY * sensitivity).toFixed(2)));
        setBrightness(newBright);
        setShowBrightnessHud(true);

        if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
        hudTimerRef.current = window.setTimeout(() => setShowBrightnessHud(false), 1400);
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    // Check for 1-Tap Focus Toggle
    if (e.changedTouches.length === 1 && !singleTapRef.current.hasMoved) {
      const dt = Date.now() - singleTapRef.current.time;
      if (dt < 320) {
        const selection = window.getSelection()?.toString().trim();
        if (!selection) {
          const target = e.target as HTMLElement;
          if (!target.closest('button, input, textarea, select, .reader-sidepanel, .page-controls, .reader-topbar, .reader-footer')) {
            setFocusMode(prev => !prev);
            if (showNotes || showContents) {
              setShowNotes(false);
              setShowContents(false);
            }
          }
        }
      }
    }

    // Commit 2-finger zoom
    if (twoFingerRef.current.active === 'pinch') {
      if (transformLayerRef.current) {
        const matrix = new DOMMatrix(getComputedStyle(transformLayerRef.current).transform);
        const appliedScale = matrix.a || 1;
        transformLayerRef.current.style.transform = 'none';
        transformLayerRef.current.style.transition = 'none';

        const finalZoom = Math.min(2.5, Math.max(0.6, +(twoFingerRef.current.startZoom * appliedScale).toFixed(2)));
        setZoom(finalZoom);
      }
    }

    twoFingerRef.current.active = 'none';
  };

  // Mouse click tap toggle for desktop/laptop
  const handleStageClick = (e: React.MouseEvent) => {
    const selection = window.getSelection()?.toString().trim();
    if (selection) return;

    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, select, .reader-sidepanel, .page-controls, .reader-topbar, .reader-footer')) {
      return;
    }
    setFocusMode(prev => !prev);
    if (showNotes || showContents) {
      setShowNotes(false);
      setShowContents(false);
    }
  };

  // Trackpad pinch-to-zoom (Ctrl + Wheel)
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      setZoom(z => Math.min(2.5, Math.max(0.6, +(z - e.deltaY * 0.005).toFixed(2))));
    }
  };

  // Page observer for continuous scroll
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
      { root: readerRef.current, threshold: 0.4 }
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
        {/* Real-time Screen Dimming Overlay */}
        <div
          className="reader-brightness-overlay"
          style={{ opacity: Math.max(0, 1 - brightness) }}
        />

        {/* Floating Brightness HUD */}
        {showBrightnessHud && (
          <div className="brightness-hud">
            <Sun size={18} />
            <div className="brightness-hud-track">
              <div className="brightness-hud-fill" style={{ width: `${Math.round(brightness * 100)}%` }} />
            </div>
            <span className="brightness-hud-value">{Math.round(brightness * 100)}%</span>
          </div>
        )}

        {/* Top Ribbon */}
        <header className="reader-topbar">
          <button className="icon-btn" onClick={closeBook} aria-label="Back to library">
            <ChevronLeft />
          </button>
          <div className="reader-book-title">
            <span className="eyebrow">NOW READING</span>
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
              onClick={() => setFocusMode(!focusMode)}
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
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
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
                  <div
                    className={`pdf-page-wrap ${turnDirection ? `turning-${turnDirection}` : ''}`}
                    onMouseUp={() => {
                      const text = window.getSelection()?.toString().trim() ?? '';
                      if (text) setSelectedText(text.slice(0, 4000));
                    }}
                  >
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
                  Array.from({ length: pageCount || 1 }, (_, i) => i + 1).map(p => (
                    <div
                      key={p}
                      id={`folio-page-${p}`}
                      data-page-number={p}
                      className="pdf-page-wrap"
                      onMouseUp={() => {
                        const text = window.getSelection()?.toString().trim() ?? '';
                        if (text) setSelectedText(text.slice(0, 4000));
                      }}
                    >
                      <Page
                        pageNumber={p}
                        scale={zoom}
                        renderTextLayer
                        renderAnnotationLayer={false}
                        loading={<div className="page-skeleton" />}
                      />
                    </div>
                  ))
                )}
              </Document>
            </div>
          </section>

          {(showNotes || showContents) && (
            <aside className="reader-sidepanel">
              <div className="panel-head">
                <div>
                  <span className="eyebrow">YOUR BOOK</span>
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
                      <button className="primary-btn small" onClick={saveNote} disabled={!selectedText.trim() && !noteDraft.trim()}>
                        <Highlighter size={15} /> Save
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

        {/* Fixed Stationary Page Navigation & Zoom Bar (Completely Immune to Scrolling) */}
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

  // Library View
  const continueBooks = [...books].filter(b => b.progress > 0 && b.progress < 100).sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)).slice(0, 3);
  const noteBook = (id: string) => books.find(b => b.id === id)?.title ?? 'Book no longer in library';

  return (
    <div className="app theme-paper library-app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BookOpen size={21} /></div>
          <span>folio<span className="brand-period">.</span></span>
        </div>
        <div className="side-label">YOUR SPACE</div>
        <button className={`nav-item ${tab === 'library' ? 'active' : ''}`} onClick={() => setTab('library')}>
          <LibraryBig size={18} /> Library <span className="nav-count">{books.length}</span>
        </button>
        <button className={`nav-item ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          <NotebookPen size={18} /> Notebook <span className="nav-count">{notes.length}</span>
        </button>
        <div className="sidebar-bottom">
          <div className="storage-card">
            <div className="storage-icon"><Files size={17} /></div>
            <div>
              <strong>Your library, your device</strong>
              <p>Books and notes stay in this browser.</p>
            </div>
          </div>
          <button className="nav-item settings-nav" onClick={exportBackup}>
            <Download size={17} /> Export backup
          </button>
          <button className="nav-item settings-nav" onClick={exportNotes}>
            <NotebookPen size={17} /> Export notes
          </button>
        </div>
      </aside>

      <main className="library-main">
        <header className="library-topbar">
          <div className="mobile-brand">
            <div className="brand-mark"><BookOpen size={19} /></div>
            <span>folio<span className="brand-period">.</span></span>
          </div>
          <div className="breadcrumbs">Personal library <span>/</span> <b>{tab === 'library' ? 'All books' : 'Notebook'}</b></div>
          <div className="topbar-right">
            <span className="offline-chip"><span className="status-dot" /> Offline ready</span>
            <button className="avatar-button" title="Local library">F</button>
          </div>
        </header>

        {tab === 'library' ? (
          <div className="library-content">
            <section className="welcome-row">
              <div>
                <div className="eyebrow">YOUR PERSONAL READING SPACE</div>
                <h1>A little more room<br className="desktop-break" /> to <em>think.</em></h1>
                <p className="welcome-copy">All your books, one calm place. Pick up where you left off.</p>
              </div>
              <button className="primary-btn import-btn" onClick={() => inputRef.current?.click()} disabled={importing}>
                <FilePlus2 size={18} />{importing ? 'Importing…' : 'Import books'}
              </button>
              <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={e => e.target.files && void importFiles(e.target.files)} />
            </section>

            {continueBooks.length > 0 && (
              <section className="continue-section">
                <div className="section-heading">
                  <div>
                    <h2>Pick up where you left off</h2>
                    <p>A good book is always waiting.</p>
                  </div>
                </div>
                <div className="continue-grid">
                  {continueBooks.map(b => (
                    <button className="continue-card" key={b.id} onClick={() => void openBook(b)}>
                      <div className="mini-cover" style={{ background: b.coverColor }}>
                        <BookOpen size={23} />
                        <span>FOLIO EDITION</span>
                      </div>
                      <div className="continue-info">
                        <strong>{b.title}</strong>
                        <span>Page {b.lastPage}{b.pageCount ? ` of ${b.pageCount}` : ''}</span>
                        <div className="progress-track"><span style={{ width: `${b.progress}%` }} /></div>
                      </div>
                      <ChevronRight size={17} />
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="library-section">
              <div className="section-heading library-heading">
                <div>
                  <h2>Your library <span className="count-badge">{books.length}</span></h2>
                  <p>Make time for what matters.</p>
                </div>
                <div className="library-tools">
                  <div className="search-box">
                    <Search size={17} />
                    <input placeholder="Search your library" value={query} onChange={e => setQuery(e.target.value)} />
                    {query && <button onClick={() => setQuery('')}><X size={14} /></button>}
                  </div>
                  <label className="sort-select">
                    <ListFilter size={16} />
                    <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} aria-label="Sort books">
                      <option value="recent">Recently opened</option>
                      <option value="added">Recently added</option>
                      <option value="title">Title A–Z</option>
                    </select>
                  </label>
                </div>
              </div>

              {visibleBooks.length ? (
                <div className="book-grid">
                  {visibleBooks.map(b => (
                    <article className="book-card" key={b.id}>
                      <button className="book-cover-button" onClick={() => void openBook(b)} aria-label={`Open ${b.title}`}>
                        <div className="book-cover" style={{ background: b.coverColor }}>
                          <div className="cover-topline">FOLIO · YOUR LIBRARY</div>
                          <BookOpen size={26} strokeWidth={1.4} />
                          <div className="cover-title">{b.title}</div>
                          <div className="cover-bottomline">PDF EDITION</div>
                        </div>
                        <span className="book-open-hint">Open book <ChevronRight size={14} /></span>
                      </button>
                      <div className="book-meta">
                        <div className="book-title-row">
                          <button onClick={() => void openBook(b)} className="book-title">{b.title}</button>
                          <button className="mini-icon" onClick={() => void deleteBook(b)} aria-label={`Remove ${b.title}`}>
                            <MoreHorizontal size={17} />
                          </button>
                        </div>
                        <span className="book-subtitle">PDF · {fmtSize(b.size)}</span>
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
                  <div className="empty-illustration"><BookOpen size={30} /></div>
                  <h3>{query ? 'No books found' : 'Your library starts here'}</h3>
                  <p>{query ? 'Try a different title or clear your search.' : 'Bring your PDFs into a calmer reading space. Your files stay on this device.'}</p>
                  {!query && (
                    <button className="primary-btn" onClick={() => inputRef.current?.click()}>
                      <Upload size={17} /> Import your first book
                    </button>
                  )}
                </div>
              )}
            </section>
            <footer className="library-footer">
              <span>Made for slower, deeper reading.</span>
              <span>{books.length} books · {notes.length} saved notes</span>
            </footer>
          </div>
        ) : (
          <div className="notebook-content">
            <div className="eyebrow">YOUR IDEAS, KEPT CLOSE</div>
            <h1>Notebook<span className="brand-period">.</span></h1>
            <p className="welcome-copy">Highlights and notes from across your reading.</p>
            <div className="notebook-toolbar">
              <span>{notes.length} saved items</span>
              <button className="secondary-btn" onClick={exportNotes} disabled={!notes.length}>
                <Download size={16} /> Export notes
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
                          Page {n.page} <ChevronRight size={14} />
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
                      <Trash2 size={15} />
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-library notebook-empty">
                <div className="empty-illustration"><Highlighter size={28} /></div>
                <h3>Your ideas will live here</h3>
                <p>Open a PDF, select a passage, and save a highlight or note. They will collect here across all your books.</p>
                <button className="secondary-btn" onClick={() => setTab('library')}>Go to library <ChevronRight size={16} /></button>
              </div>
            )}
          </div>
        )}
      </main>

      <nav className="mobile-nav">
        <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
          <LibraryBig size={19} /><span>Library</span>
        </button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
          <NotebookPen size={19} /><span>Notebook</span>
        </button>
        <button onClick={() => inputRef.current?.click()}>
          <FilePlus2 size={19} /><span>Import</span>
        </button>
      </nav>

      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}
