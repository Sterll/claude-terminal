/**
 * Chat IPC Handlers
 * Bridges renderer chat UI with ChatService (Claude Agent SDK)
 */

const { ipcMain } = require('electron');
const chatService = require('../services/ChatService');
const { sendFeaturePing } = require('../services/TelemetryService');

function registerChatHandlers() {
  // Start a new chat session (streaming input mode)
  ipcMain.handle('chat-start', async (_event, params) => {
    try {
      const sessionId = await chatService.startSession(params);
      return { success: true, sessionId };
    } catch (err) {
      console.error('[chat-start] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Send a follow-up message to existing session
  ipcMain.handle('chat-send', async (_event, { sessionId, text, images, mentions }) => {
    try {
      sendFeaturePing('chat:message');
      chatService.sendMessage(sessionId, text, images, mentions);
      return { success: true };
    } catch (err) {
      console.error('[chat-send] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Close a chat session
  ipcMain.on('chat-close', (_event, { sessionId }) => {
    chatService.closeSession(sessionId);
  });

  // Permission response from renderer (allow/deny)
  ipcMain.on('chat-permission-response', (_event, { requestId, result }) => {
    chatService.resolvePermission(requestId, result);
  });

  // Interrupt current turn (stop button)
  ipcMain.on('chat-interrupt', (_event, { sessionId }) => {
    chatService.interrupt(sessionId);
  });

  // Enable always-allow mode for a session
  ipcMain.on('chat-always-allow', (_event, { sessionId }) => {
    chatService.setAlwaysAllow(sessionId);
  });

  // Change model mid-session
  ipcMain.handle('chat-set-model', async (_event, { sessionId, model }) => {
    try {
      await chatService.setModel(sessionId, model);
      return { success: true };
    } catch (err) {
      console.error('[chat-set-model] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Change effort level mid-session
  ipcMain.handle('chat-set-effort', async (_event, { sessionId, effort }) => {
    try {
      await chatService.setEffort(sessionId, effort);
      return { success: true };
    } catch (err) {
      console.error('[chat-set-effort] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Generate a short tab name from user message (persistent haiku session)
  ipcMain.handle('chat-generate-tab-name', async (_event, { userMessage }) => {
    try {
      const name = await chatService.generateTabName(userMessage);
      return { success: true, name };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Background skill/agent generation via Agent SDK (fire-and-forget)
  ipcMain.handle('chat-generate-skill-agent', async (_event, params) => {
    try {
      const genId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Run generation in background, send result via IPC event
      chatService.generateSkillOrAgent({ ...params, genId })
        .then(result => {
          chatService._send('chat-generation-complete', { genId, result });
        })
        .catch(err => {
          chatService._send('chat-generation-complete', { genId, result: { success: false, type: params.type, error: err.message, genId } });
        });
      return { genId };
    } catch (err) {
      console.error('[chat-generate-skill-agent] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Analyze chat session for CLAUDE.md suggestions
  ipcMain.handle('chat-analyze-session', async (_event, { messages, projectPath }) => {
    try {
      return await chatService.analyzeSessionForClaudeMd(messages, projectPath);
    } catch (err) {
      console.error('[chat-analyze-session] Error:', err.message);
      return { suggestions: [], claudeMdExists: false };
    }
  });

  // Apply selected CLAUDE.md sections
  ipcMain.handle('claude-md-apply', async (_event, { projectPath, sections }) => {
    try {
      return chatService.applyClaudeMdSections(projectPath, sections);
    } catch (err) {
      console.error('[claude-md-apply] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Analyze chat session for workspace knowledge base enrichment
  ipcMain.handle('workspace-analyze-session', async (_event, { messages, workspace, existingDocs }) => {
    try {
      return await chatService.analyzeSessionForWorkspace(messages, workspace, existingDocs || []);
    } catch (err) {
      console.error('[workspace-analyze-session] Error:', err.message);
      return { suggestions: [] };
    }
  });

  // Cancel a background generation
  ipcMain.on('chat-cancel-generation', (_event, { genId }) => {
    chatService.cancelGeneration(genId);
  });

  // Generate follow-up suggestions after a Claude response
  ipcMain.handle('chat-generate-suggestions', async (_event, { lastAssistantText, lastUserText, projectContext }) => {
    try {
      const suggestions = await chatService.generateSuggestions(lastAssistantText || '', lastUserText || '', projectContext || null);
      return { success: true, suggestions };
    } catch (err) {
      console.error('[chat-generate-suggestions] Error:', err.message);
      return { success: false, suggestions: [] };
    }
  });
}

module.exports = { registerChatHandlers };
