// Windows fails a recursive removal while a handle inside the tree is still
// closing. A stream released with destroy() closes its descriptor
// asynchronously, so a teardown that runs right after the last test can hit
// ENOTEMPTY / EBUSY / EPERM even though every test passed. Unlinking an open
// file is legal on POSIX, which is why this only ever shows up on
// windows-latest, and always in afterAll - never in a test.
//
// `force: true` does not help: it only suppresses "does not exist", it never
// retries. Node's answer is maxRetries / retryDelay, which retry exactly those
// Windows errors. Rather than ask every suite to remember that, this installs
// the retry as the default for recursive removals, so the suites that exist and
// the ones written next both inherit it.

const REMOVAL_RETRY = { maxRetries: 10, retryDelay: 50 };

const INSTALLED = Symbol.for('claude-terminal.tests.fsRemovalRetry');

// Only recursive removals are touched, and only when the caller has not already
// chosen its own retry policy.
function withRemovalRetry(options) {
  if (!options || options.recursive !== true) return options;
  if (options.maxRetries !== undefined) return options;
  return { ...options, ...REMOVAL_RETRY };
}

function installFsRemovalRetry(fs) {
  if (!fs || fs[INSTALLED]) return fs;

  const { rmSync, rm } = fs;

  if (typeof rmSync === 'function') {
    fs.rmSync = function (target, options) {
      return rmSync.call(this, target, withRemovalRetry(options));
    };
  }

  if (typeof rm === 'function') {
    fs.rm = function (target, options, callback) {
      // fs.rm(target, callback) - nothing to inject into.
      if (typeof options === 'function' || options === undefined) {
        return rm.call(this, target, options, callback);
      }
      return rm.call(this, target, withRemovalRetry(options), callback);
    };
  }

  const promises = fs.promises;
  if (promises && typeof promises.rm === 'function') {
    const promisesRm = promises.rm;
    promises.rm = function (target, options) {
      return promisesRm.call(this, target, withRemovalRetry(options));
    };
  }

  Object.defineProperty(fs, INSTALLED, { value: true, enumerable: false });
  return fs;
}

module.exports = { REMOVAL_RETRY, withRemovalRetry, installFsRemovalRetry };
