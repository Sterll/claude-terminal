/**
 * The composer's attachment tray.
 *
 * Three destinations, one per content block the CLI understands: images and
 * PDFs travel as base64 and get their own payload, while text files reuse the
 * mention channel — a mention has always been "a label plus some text resolved
 * at send time", which is exactly what an attached .md is. Anything too big
 * for its ceiling is handed over as a path instead, so the agent's Read tool
 * opens it on demand rather than the context paying for a blob it cannot seek.
 *
 * The counters are the subtle part and the reason this is one object rather
 * than a few loose functions. Reads are asynchronous but `addFiles()` loops
 * synchronously, so a cap tested against the landed count alone reads zero for
 * every file of a batch — drop eight images and all eight pass, then five land
 * and three vanish without a word. Each read reserves its slot in the loop and
 * releases it when it settles.
 */

const { escapeHtml } = require('../../../utils');
const { t } = require('../../../i18n');
const { parseDroppedPathsPayload } = require('../../../utils/dropPaths');
const {
  classifyFile,
  shouldInlineText,
  formatBytes,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
} = require('../../../utils/attachments');

/**
 * @param {object} deps
 * @param {HTMLElement} deps.chatView       drop target
 * @param {HTMLElement} deps.inputEl        composer, to take focus back
 * @param {HTMLElement} deps.imagePreview   the thumbnail strip
 * @param {() => object} deps.getProject    read late: the tab can be rebound
 * @param {Function} deps.onAttachmentChip  file chips live on the mention rail
 * @param {Function} deps.onMentionChip     dropped paths become file mentions
 * @param {() => number} deps.countPdfAttachments
 * @param {() => number} deps.countTextAttachments
 */
function createAttachmentTray({
  chatView, inputEl, imagePreview, getProject,
  onAttachmentChip, onMentionChip,
  countPdfAttachments, countTextAttachments,
}) {
  const pendingImages = []; // Array of { base64, mediaType, name, dataUrl }
  const MAX_IMAGE_SIZE = MAX_IMAGE_BYTES;
  const MAX_PENDING_IMAGES = 5;
  const MAX_PENDING_DOCUMENTS = 5;
  const MAX_PENDING_TEXTS = 10;
  // What all inlined text files together may add to one turn. Ten files at the
  // 128 KB per-file ceiling is 1.3 MB of context nobody asked to pay for, and
  // a dropped folder reaches that without the user noticing they dropped one.
  const MAX_TOTAL_INLINE_TEXT_BYTES = 512 * 1024;

  // Reads are asynchronous, but addFiles() loops synchronously — so a cap
  // tested against the landed count alone reads zero for every file of a
  // batch: drop eight images and all eight pass the test, then five land and
  // three vanish without a word. The reservation is taken in the loop and
  // released when the read settles, so the count the cap sees is the count
  // that will exist.
  let inflightImages = 0;
  let inflightDocuments = 0;
  let inflightTexts = 0;
  let inlinedTextBytes = 0;

  function attachmentToast(message, type = 'warning') {
    const Toast = require('../Toast');
    Toast.showToast({ message, type });
  }

  /**
   * Route each file to the content block that fits it. Anything we cannot send
   * now says so out loud — the old code dropped unsupported files in silence,
   * which read as the composer being broken rather than as a refusal.
   */
  function addFiles(files) {
    for (const file of files) {
      switch (classifyFile(file)) {
        case 'image': addImageFile(file); break;
        case 'pdf': addPdfFile(file); break;
        case 'text': addTextFile(file); break;
        case 'secret':
          attachmentToast(t('chat.attachSecret', { name: file.name }));
          break;
        default:
          attachmentToast(t('chat.attachUnsupported', { name: file.name }));
      }
    }
  }

  function addImageFile(file) {
    if (pendingImages.length + inflightImages >= MAX_PENDING_IMAGES) {
      attachmentToast(t('chat.attachTooMany', { max: MAX_PENDING_IMAGES }));
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      attachmentToast(t('chat.attachTooLarge', { name: file.name, max: formatBytes(MAX_IMAGE_SIZE) }));
      return;
    }
    inflightImages++;
    const reader = new FileReader();
    reader.onload = () => {
      inflightImages--;
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      pendingImages.push({ base64, mediaType: file.type || 'image/png', name: file.name, dataUrl });
      renderImagePreview();
    };
    reader.onerror = () => {
      inflightImages--;
      attachmentToast(t('chat.attachReadFailed', { name: file.name }), 'error');
    };
    reader.readAsDataURL(file);
  }

  /**
   * PDFs travel as a base64 `document` block — the very shape the Claude Code
   * binary builds itself when its Read tool opens one. Past the size ceiling we
   * hand over the path instead, so a 200 MB scan does not become a 270 MB
   * request that the API would refuse anyway.
   */
  function addPdfFile(file) {
    if (file.size > MAX_PDF_BYTES) {
      if (file.path) {
        addPathAttachment(file);
      } else {
        attachmentToast(t('chat.attachTooLarge', { name: file.name, max: formatBytes(MAX_PDF_BYTES) }));
      }
      return;
    }
    if (countPdfAttachments() + inflightDocuments >= MAX_PENDING_DOCUMENTS) {
      attachmentToast(t('chat.attachTooMany', { max: MAX_PENDING_DOCUMENTS }));
      return;
    }
    inflightDocuments++;
    const reader = new FileReader();
    reader.onload = () => {
      inflightDocuments--;
      onAttachmentChip(file.name, {
        kind: 'pdf',
        name: file.name,
        base64: String(reader.result).split(',')[1],
      });
    };
    reader.onerror = () => {
      inflightDocuments--;
      attachmentToast(t('chat.attachReadFailed', { name: file.name }), 'error');
    };
    reader.readAsDataURL(file);
  }

  /**
   * Text files ride the mention channel: a chip in the composer, the contents
   * resolved at send time. Above the inline ceiling only the path is sent and
   * the agent's Read tool opens it — it can seek and page, where an inlined
   * blob can only sit in the context being paid for.
   */
  function addTextFile(file) {
    if (!shouldInlineText({ size: file.size, path: file.path })) {
      addPathAttachment(file);
      return;
    }
    // Images and PDFs were capped; text was not, so a dropped folder inlined
    // every file in it. A file that would break either ceiling is handed over
    // as a path when it has one — the agent's Read tool opens it on demand —
    // and refused out loud when it does not.
    const overBudget = inlinedTextBytes + file.size > MAX_TOTAL_INLINE_TEXT_BYTES;
    if (countTextAttachments() + inflightTexts >= MAX_PENDING_TEXTS || overBudget) {
      if (file.path) {
        addPathAttachment(file);
      } else {
        attachmentToast(t('chat.attachTooMany', { max: MAX_PENDING_TEXTS }));
      }
      return;
    }
    inflightTexts++;
    inlinedTextBytes += file.size;
    const reader = new FileReader();
    reader.onload = () => {
      inflightTexts--;
      onAttachmentChip(file.name, {
        kind: 'text',
        name: file.name,
        path: file.path || '',
        content: String(reader.result ?? ''),
      });
    };
    reader.onerror = () => {
      inflightTexts--;
      inlinedTextBytes -= file.size;
      attachmentToast(t('chat.attachReadFailed', { name: file.name }), 'error');
    };
    reader.readAsText(file);
  }

  /** Hand the agent a path to read rather than the bytes themselves. */
  function addPathAttachment(file) {
    onAttachmentChip(file.name, {
      kind: 'path',
      name: file.name,
      path: file.path,
      size: file.size,
    });
  }

  function removeImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreview();
  }

  function renderImagePreview() {
    if (pendingImages.length === 0) {
      imagePreview.style.display = 'none';
      imagePreview.innerHTML = '';
      return;
    }
    imagePreview.style.display = 'flex';
    imagePreview.innerHTML = pendingImages.map((img, i) => `
      <div class="chat-image-thumb" data-index="${i}">
        <img src="${img.dataUrl}" alt="${escapeHtml(img.name)}" />
        <button class="chat-image-remove" data-index="${i}" title="${t('common.remove')}">&times;</button>
      </div>
    `).join('');
    imagePreview.querySelectorAll('.chat-image-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeImage(parseInt(btn.dataset.index));
      });
    });
  }

  // Drag & drop on chat area
  chatView.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatView.classList.add('chat-dragover');
  });
  chatView.addEventListener('dragleave', (e) => {
    if (!chatView.contains(e.relatedTarget)) {
      chatView.classList.remove('chat-dragover');
    }
  });
  chatView.addEventListener('drop', (e) => {
    e.preventDefault();
    chatView.classList.remove('chat-dragover');
    handleChatDrop(e);
  });

  function handleChatDrop(e) {
    // Priority: real files dropped from the OS. Routing happens in addFiles,
    // so a .md from the desktop lands here the same way a screenshot does —
    // this used to filter on image MIME types and drop everything else.
    const droppedFiles = Array.from(e.dataTransfer.files || []);
    if (droppedFiles.length) {
      addFiles(droppedFiles);
      inputEl.focus();
      return;
    }

    // Fallback: text/plain with file paths (from internal FileExplorer)
    const textData = e.dataTransfer.getData('text/plain') || '';
    const { fs, path } = window.electron_nodeModules;
    const parsed = parseDroppedPathsPayload(textData, { fs, path, projectRoot: getProject()?.path || '' });
    if (!parsed) return;

    for (const missing of parsed.missing) {
      const Toast = require('../Toast');
      Toast.showToast({
        message: (t('chat.fileNotFound') || 'File not found') + ': ' + missing,
        type: 'error',
      });
    }

    for (const file of parsed.files) {
      onMentionChip('file', { path: file.path, fullPath: file.fullPath });
    }

    if (parsed.directories.length > 0) {
      const Toast = require('../Toast');
      Toast.showToast({
        message: t('chat.dropFolderNotSupported') || 'Folders cannot be attached, drop files instead',
        type: 'warning',
      });
    }

    if (parsed.files.length > 0) {
      inputEl.focus();
    }
  }


  return {
    addFiles,
    handleDrop: handleChatDrop,
    render: renderImagePreview,
    /** The composer's images, handed over and cleared — send owns them now. */
    take() { const images = pendingImages.splice(0); renderImagePreview(); return images; },
    /** Used by the remote-control and visual paths, which build blocks directly. */
    push(img) { pendingImages.push(img); },
    count() { return pendingImages.length; },
    clear() { pendingImages.length = 0; inlinedTextBytes = 0; renderImagePreview(); },
  };
}

module.exports = { createAttachmentTray };
