/**
 * feedback.js — Transcription error reporting for repo-story player.
 *
 * Provides flagging UI per transcript chunk and POSTs reports to a generic
 * event API. Stores flagged chunks in localStorage for visual persistence.
 * Degrades gracefully when no feedbackUrl is configured.
 */
var RepoStoryFeedback = (function () {
  var feedbackUrl = null;
  var storageKey = 'rs-flagged-chunks';

  function getFlagged() {
    try {
      return JSON.parse(localStorage.getItem(storageKey)) || {};
    } catch (e) {
      return {};
    }
  }

  function setFlagged(flagged) {
    localStorage.setItem(storageKey, JSON.stringify(flagged));
  }

  function flagKey(bookSlug, chapterIndex, chunkIndex) {
    return bookSlug + ':' + chapterIndex + ':' + chunkIndex;
  }

  function isFlagged(bookSlug, chapterIndex, chunkIndex) {
    return !!getFlagged()[flagKey(bookSlug, chapterIndex, chunkIndex)];
  }

  function flag(bookSlug, chapterIndex, chunkIndex, chunkText, timestamp) {
    var key = flagKey(bookSlug, chapterIndex, chunkIndex);
    var flagged = getFlagged();
    flagged[key] = true;
    setFlagged(flagged);

    if (!feedbackUrl) return;

    var payload = {
      project: 'repo-story',
      type: 'transcription-error',
      context: {
        bookSlug: bookSlug,
        chapterIndex: chapterIndex,
        chunkIndex: chunkIndex,
        chunkText: chunkText,
        timestamp: timestamp
      }
    };

    fetch(feedbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(function () {
      // Silent failure — flag is persisted locally regardless
    });
  }

  function unflag(bookSlug, chapterIndex, chunkIndex) {
    var key = flagKey(bookSlug, chapterIndex, chunkIndex);
    var flagged = getFlagged();
    delete flagged[key];
    setFlagged(flagged);
  }

  function init(url) {
    feedbackUrl = url || null;
  }

  return {
    init: init,
    flag: flag,
    unflag: unflag,
    isFlagged: isFlagged
  };
})();
