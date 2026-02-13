/**
 * Python State Module
 * Manages Python environment info per project
 */

const { State } = require('../../../renderer/state/State');

const initialState = {
  pythonInfo: new Map() // projectIndex -> { pythonVersion, venvPath, projectType, dependencies, mainEntry }
};

const pythonState = new State(initialState);

function getPythonInfo(projectIndex) {
  return pythonState.get().pythonInfo.get(projectIndex) || {
    pythonVersion: null,
    venvPath: null,
    projectType: null,
    dependencies: 0,
    mainEntry: null
  };
}

function setPythonInfo(projectIndex, info) {
  const map = pythonState.get().pythonInfo;
  map.set(projectIndex, info);
  pythonState.setProp('pythonInfo', map);
}

function removePythonInfo(projectIndex) {
  const map = pythonState.get().pythonInfo;
  map.delete(projectIndex);
  pythonState.setProp('pythonInfo', map);
}

module.exports = {
  pythonState,
  getPythonInfo,
  setPythonInfo,
  removePythonInfo
};
