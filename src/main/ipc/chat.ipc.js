/**
 * Chat IPC Handlers
 * Bridges renderer chat UI with ChatService (Claude Agent SDK)
 */

const { ipcMain } = require('electron');
const chatService = require('../services/ChatService');

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
  ipcMain.handle('chat-send', async (_event, { sessionId, text }) => {
    try {
      chatService.sendMessage(sessionId, text);
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

  // Generate a short tab name from user message (persistent haiku session)
  ipcMain.handle('chat-generate-tab-name', async (_event, { userMessage }) => {
    try {
      const name = await chatService.generateTabName(userMessage);
      return { success: true, name };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerChatHandlers };
