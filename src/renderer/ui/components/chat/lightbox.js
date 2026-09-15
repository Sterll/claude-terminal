/**
 * Full-screen viewer for images in the transcript.
 *
 * Built lazily and parked on `document.body` rather than inside the chat pane:
 * it has to sit above the composer, the tab strip and the modals, and nesting
 * it in a scroll container that clips its own overflow would fight all three.
 *
 * Owns nothing of the conversation — hand it a list of URLs and an index. The
 * key handler is bound on open and released on close, so a closed lightbox
 * leaves no listener behind to swallow Escape from whatever has focus next.
 */

function createLightbox() {
  let el = null;
  let images = [];
  let index = 0;

  function ensure() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'chat-lightbox';
    el.innerHTML = `
      <div class="chat-lightbox-backdrop"></div>
      <button class="chat-lightbox-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
      <button class="chat-lightbox-prev" aria-label="Previous">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
      </button>
      <button class="chat-lightbox-next" aria-label="Next">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
      </button>
      <img class="chat-lightbox-img" alt="" />
      <div class="chat-lightbox-counter"></div>
    `;
    document.body.appendChild(el);

    el.querySelector('.chat-lightbox-backdrop').addEventListener('click', close);
    el.querySelector('.chat-lightbox-close').addEventListener('click', close);
    el.querySelector('.chat-lightbox-prev').addEventListener('click', () => navigate(-1));
    el.querySelector('.chat-lightbox-next').addEventListener('click', () => navigate(1));
  }

  function open(srcs, startIndex) {
    ensure();
    images = srcs;
    index = startIndex;
    updateImage();
    requestAnimationFrame(() => el.classList.add('active'));
    document.addEventListener('keydown', keyHandler);
  }

  function close() {
    if (!el) return;
    el.classList.remove('active');
    document.removeEventListener('keydown', keyHandler);
  }

  function navigate(delta) {
    index = (index + delta + images.length) % images.length;
    updateImage();
  }

  function updateImage() {
    const img = el.querySelector('.chat-lightbox-img');
    const counter = el.querySelector('.chat-lightbox-counter');
    const prevBtn = el.querySelector('.chat-lightbox-prev');
    const nextBtn = el.querySelector('.chat-lightbox-next');

    img.src = images[index];

    if (images.length > 1) {
      counter.textContent = `${index + 1} / ${images.length}`;
      counter.style.display = '';
      prevBtn.style.display = '';
      nextBtn.style.display = '';
    } else {
      counter.style.display = 'none';
      prevBtn.style.display = 'none';
      nextBtn.style.display = 'none';
    }
  }

  function keyHandler(e) {
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowLeft') {
      navigate(-1);
    } else if (e.key === 'ArrowRight') {
      navigate(1);
    }
  }

  function destroy() {
    images.length = 0;
    document.removeEventListener('keydown', keyHandler);
    if (el?.parentNode) el.parentNode.removeChild(el);
    el = null;
  }

  return { open, close, destroy };
}

module.exports = { createLightbox };
