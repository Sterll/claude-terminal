/**
 * PDF Viewer Module (ESM, lazy-loaded)
 * Renders PDF files page-by-page using canvas with toolbar controls.
 * Uses pdfjs-dist (Mozilla pdf.js).
 */

import * as pdfjsLib from 'pdfjs-dist';

// Point to the worker file copied to dist/ by the build script.
// In Electron the page is loaded from a file:// URL, so we resolve
// relative to the current script's location (dist/).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const DEFAULT_SCALE = 1.5;

/**
 * Render a PDF into the given container element.
 * @param {HTMLElement} container - The .file-viewer-pdf element
 * @param {string} fileUrl - file:/// URL to the PDF
 * @returns {{ destroy: () => void }}
 */
export function renderPdf(container, fileUrl) {
  let pdfDoc = null;
  let currentPage = 1;
  let currentScale = DEFAULT_SCALE;
  let totalPages = 0;
  let destroyed = false;
  let renderTasks = [];
  const canvasPages = new Map(); // page number -> canvas element

  // Build toolbar
  const toolbar = container.querySelector('.file-viewer-pdf-toolbar');
  const pagesContainer = container.querySelector('.file-viewer-pdf-pages');

  const observer = new IntersectionObserver(onIntersect, {
    root: pagesContainer,
    rootMargin: '200px',
    threshold: 0.01
  });

  toolbar.innerHTML = `
    <button class="pdf-btn pdf-prev" title="Previous page">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <span class="pdf-page-info">
      <input type="number" class="pdf-page-input" min="1" value="1" />
      <span class="pdf-page-sep">/</span>
      <span class="pdf-page-total">-</span>
    </span>
    <button class="pdf-btn pdf-next" title="Next page">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M9 18l6-6-6-6"/></svg>
    </button>
    <span class="pdf-toolbar-sep"></span>
    <button class="pdf-btn pdf-zoom-out" title="Zoom out">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M5 12h14"/></svg>
    </button>
    <span class="pdf-zoom-label">${Math.round(currentScale * 100)}%</span>
    <button class="pdf-btn pdf-zoom-in" title="Zoom in">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>
    </button>
    <button class="pdf-btn pdf-fit" title="Fit width">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/></svg>
    </button>
  `;

  const prevBtn = toolbar.querySelector('.pdf-prev');
  const nextBtn = toolbar.querySelector('.pdf-next');
  const pageInput = toolbar.querySelector('.pdf-page-input');
  const pageTotal = toolbar.querySelector('.pdf-page-total');
  const zoomOutBtn = toolbar.querySelector('.pdf-zoom-out');
  const zoomInBtn = toolbar.querySelector('.pdf-zoom-in');
  const zoomLabel = toolbar.querySelector('.pdf-zoom-label');
  const fitBtn = toolbar.querySelector('.pdf-fit');

  // Event handlers
  prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
  nextBtn.addEventListener('click', () => goToPage(currentPage + 1));
  pageInput.addEventListener('change', () => goToPage(parseInt(pageInput.value, 10)));
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToPage(parseInt(pageInput.value, 10));
  });
  zoomOutBtn.addEventListener('click', () => zoom(-1));
  zoomInBtn.addEventListener('click', () => zoom(1));
  fitBtn.addEventListener('click', fitWidth);

  // Show loading
  pagesContainer.innerHTML = '<div class="pdf-loading">Loading PDF...</div>';

  // Load the PDF
  const loadingTask = pdfjsLib.getDocument(fileUrl);
  loadingTask.promise.then(pdf => {
    if (destroyed) return;
    pdfDoc = pdf;
    totalPages = pdf.numPages;
    pageTotal.textContent = totalPages;
    pageInput.max = totalPages;
    pagesContainer.innerHTML = '';

    // Create placeholder divs for all pages
    for (let i = 1; i <= totalPages; i++) {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'pdf-page-container';
      pageDiv.dataset.page = i;

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      pageDiv.appendChild(canvas);
      pagesContainer.appendChild(pageDiv);
      canvasPages.set(i, canvas);
      observer.observe(pageDiv);
    }

    // Render first visible pages
    renderPage(1);
    if (totalPages > 1) renderPage(2);
  }).catch(err => {
    if (destroyed) return;
    pagesContainer.innerHTML = `<div class="pdf-loading pdf-error">Failed to load PDF: ${err.message}</div>`;
  });

  function onIntersect(entries) {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const pageNum = parseInt(entry.target.dataset.page, 10);
        renderPage(pageNum);
      }
    }
  }

  async function renderPage(pageNum) {
    if (destroyed || !pdfDoc) return;
    const canvas = canvasPages.get(pageNum);
    if (!canvas || canvas.dataset.rendered === String(currentScale)) return;

    try {
      const page = await pdfDoc.getPage(pageNum);
      if (destroyed) return;

      const viewport = page.getViewport({ scale: currentScale });
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';

      const task = page.render({ canvasContext: ctx, viewport });
      renderTasks.push(task);
      await task.promise;
      canvas.dataset.rendered = String(currentScale);
    } catch (e) {
      // Render cancelled or page error — ignore
    }
  }

  function goToPage(num) {
    if (!pdfDoc) return;
    num = Math.max(1, Math.min(num, totalPages));
    currentPage = num;
    pageInput.value = num;

    const pageDiv = pagesContainer.querySelector(`[data-page="${num}"]`);
    if (pageDiv) {
      pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function zoom(direction) {
    const currentIdx = ZOOM_STEPS.findIndex(s => s >= currentScale);
    let nextIdx = currentIdx + direction;
    nextIdx = Math.max(0, Math.min(nextIdx, ZOOM_STEPS.length - 1));
    setScale(ZOOM_STEPS[nextIdx]);
  }

  function fitWidth() {
    if (!pdfDoc) return;
    const containerWidth = pagesContainer.clientWidth - 32; // padding
    pdfDoc.getPage(1).then(page => {
      const viewport = page.getViewport({ scale: 1 });
      const fitScale = containerWidth / viewport.width;
      setScale(fitScale);
    });
  }

  function setScale(scale) {
    currentScale = scale;
    zoomLabel.textContent = Math.round(scale * 100) + '%';

    // Cancel pending renders
    for (const task of renderTasks) {
      try { task.cancel(); } catch (e) { /* ignore */ }
    }
    renderTasks = [];

    // Mark all canvases as needing re-render
    canvasPages.forEach(canvas => {
      canvas.dataset.rendered = '';
    });

    // Re-render visible pages
    const visiblePages = getVisiblePages();
    for (const pageNum of visiblePages) {
      renderPage(pageNum);
    }
  }

  function getVisiblePages() {
    const pages = [];
    const rect = pagesContainer.getBoundingClientRect();
    canvasPages.forEach((canvas, pageNum) => {
      const pageDiv = canvas.parentElement;
      const pageRect = pageDiv.getBoundingClientRect();
      if (pageRect.bottom > rect.top - 200 && pageRect.top < rect.bottom + 200) {
        pages.push(pageNum);
      }
    });
    return pages;
  }

  // Track current page on scroll
  let scrollTimer = null;
  pagesContainer.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const containerRect = pagesContainer.getBoundingClientRect();
      const centerY = containerRect.top + containerRect.height / 2;
      let closestPage = 1;
      let closestDist = Infinity;

      canvasPages.forEach((canvas, pageNum) => {
        const pageRect = canvas.parentElement.getBoundingClientRect();
        const pageCenterY = pageRect.top + pageRect.height / 2;
        const dist = Math.abs(pageCenterY - centerY);
        if (dist < closestDist) {
          closestDist = dist;
          closestPage = pageNum;
        }
      });

      currentPage = closestPage;
      pageInput.value = closestPage;
    }, 100);
  });

  return {
    destroy() {
      destroyed = true;
      observer.disconnect();
      clearTimeout(scrollTimer);
      for (const task of renderTasks) {
        try { task.cancel(); } catch (e) { /* ignore */ }
      }
      renderTasks = [];
      if (pdfDoc) {
        pdfDoc.destroy();
        pdfDoc = null;
      }
      canvasPages.clear();
    }
  };
}
