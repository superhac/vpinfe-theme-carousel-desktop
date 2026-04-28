/*
Testing theme with carousel layout
*/

// Globals
windowName = ""
currentTableIndex = 0;
isAnimating = false;
wheelMode = "tables";
collectionEntries = [];
currentCollectionIndex = 0;
attractIdleTimer = null;
attractAdvanceTimer = null;
attractModeActive = false;
attractSuspended = false;

const carouselAnimationMs = 180;
const ATTRACT_IDLE_MS = 60000;
const ATTRACT_STEP_MS = 7000;

// Audio manager for table audio with crossfade
// Uses a single reusable Audio element. Tries direct audio.play() first
// (works in Chromium with --autoplay-policy flag). If blocked by autoplay
// policy (pywebview/WebKitGTK), falls back to trigger_audio_play via Python's
// evaluate_js which runs in a privileged context.
const tableAudio = {
    audio: Object.assign(new Audio(), { loop: true }),
    fadeId: null,        // interval handle for current fade
    fadeDuration: 500,   // fade duration in ms
    maxVolume: 0.8,
    currentUrl: null,    // track what's currently loaded/playing

    play(url, retries = 3) {
        if (!url) {
            this.stop();
            return;
        }

        // If same track is already playing, do nothing
        if (this.currentUrl === url && !this.audio.paused) {
            return;
        }

        const audio = this.audio;

        // Stop any current fade and immediately switch source
        clearInterval(this.fadeId);
        audio.pause();
        audio.volume = 0;
        audio.src = url;
        this.currentUrl = url;

        // Try direct play first (Chromium allows this via --autoplay-policy)
        audio.play().then(() => {
            if (this.currentUrl === url) {
                this._fade(0, this.maxVolume);
            }
        }).catch(e => {
            if (e.name === 'NotAllowedError') {
                // Autoplay blocked (pywebview/WebKitGTK) - wait for audio to
                // load, then ask Python to play via evaluate_js (privileged context)
                console.log("Audio autoplay blocked, falling back to Python bridge");
                this._retries = retries;
                this._triggerWhenReady(url);
            } else {
                console.log("Audio play failed:", e.message, `(${retries} retries left)`);
                // Retry - HTTP server may not be ready yet on startup
                if (retries > 0 && this.currentUrl === url) {
                    setTimeout(() => this.play(url, retries - 1), 1000);
                }
            }
        });
    },

    // Wait for audio source to load, then request privileged play from Python.
    // URL check ensures stale requests from fast navigation are ignored.
    _triggerWhenReady(url) {
        if (this.currentUrl !== url) return;
        if (this.audio.readyState >= 2) {
            vpin.call("trigger_audio_play").catch(() => {
                console.log("trigger_audio_play not available");
            });
        } else {
            this.audio.addEventListener('canplay', () => {
                if (this.currentUrl === url) {
                    vpin.call("trigger_audio_play").catch(() => {
                        console.log("trigger_audio_play not available");
                    });
                }
            }, { once: true });
        }
    },

    // Called from Python via evaluate_js (privileged context bypasses autoplay policy).
    // Audio is guaranteed loaded by _triggerWhenReady before this is called.
    _resumePlay() {
        const url = this.currentUrl;
        const retries = this._retries || 0;
        if (!url) return;

        this.audio.play().then(() => {
            if (this.currentUrl === url) {
                this._fade(0, this.maxVolume);
            }
        }).catch(e => {
            console.log("Audio play failed:", e.message, `(${retries} retries left)`);
            if (retries > 0 && this.currentUrl === url) {
                this._retries = retries - 1;
                setTimeout(() => this._triggerWhenReady(url), 500);
            }
        });
    },

    stop() {
        if (this.audio && !this.audio.paused) {
            this._fade(this.audio.volume, 0, () => {
                this.audio.pause();
                this.currentUrl = null;
            });
        } else {
            clearInterval(this.fadeId);
            this.currentUrl = null;
        }
    },

    _fade(from, to, onComplete) {
        clearInterval(this.fadeId);
        const audio = this.audio;
        if (!audio) { if (onComplete) onComplete(); return; }

        audio.volume = from;
        const steps = this.fadeDuration / 20;
        const delta = (to - from) / steps;

        this.fadeId = setInterval(() => {
            const next = audio.volume + delta;
            if ((delta > 0 && next >= to) || (delta < 0 && next <= to) || delta === 0) {
                audio.volume = to;
                clearInterval(this.fadeId);
                if (onComplete) onComplete();
            } else {
                audio.volume = next;
            }
        }, 20);
    }
};

// init the core interface to VPinFE
const vpin = new VPinFECore();
vpin.init();
window.vpin = vpin // main menu needs this to call back in.

// Register receiveEvent globally BEFORE vpin.ready to avoid timing issues
window.receiveEvent = receiveEvent;

// wait for VPinFECore to be ready
vpin.ready.then(async () => {
    await vpin.call("get_my_window_name")
        .then(result => {
            windowName = result;
        });

    vpin.registerInputHandler(handleInput);

    // Initialize the display
    updateScreen();
    if (windowName === "table") {
        setupAttractMode();
        markUserActivity(false);
    }
});

// listener for windows events.  VPinFECore uses this to send events to all windows.
async function receiveEvent(message) {
    // Let VPinFECore handle the data refresh logic
    await vpin.handleEvent(message);

    // Handle UI updates based on event type
    if (message.type == "TableIndexUpdate") {
        if (isCollectionMode()) leaveCollectionMode();
        currentTableIndex = message.index;
        updateScreen();
        if (!attractModeActive) markUserActivity(false);
    }
    else if (message.type == "TableLaunching") {
        attractSuspended = true;
        stopAttractMode();
        tableAudio.stop();
        await fadeOut();
    }
    else if (message.type == "TableLaunchComplete") {
        attractSuspended = false;
        fadeIn();
        if (windowName === "table") {
            tableAudio.play(vpin.getAudioURL(currentTableIndex));
            markUserActivity(false);
        }
    }
    else if (message.type == "RemoteLaunching") {
        // Remote launch from manager UI
        attractSuspended = true;
        stopAttractMode();
        tableAudio.stop();
        showRemoteLaunchOverlay(message.table_name);
        await fadeOut();
    }
    else if (message.type == "RemoteLaunchComplete") {
        // Remote launch completed
        attractSuspended = false;
        hideRemoteLaunchOverlay();
        fadeIn();
        if (windowName === "table") {
            tableAudio.play(vpin.getAudioURL(currentTableIndex));
            markUserActivity(false);
        }
    }
    else if (message.type == "TableDataChange") {
        if (isCollectionMode()) leaveCollectionMode();
        currentTableIndex = message.index;
        updateScreen();
        if (!attractModeActive) markUserActivity(false);
    }
}

// create an input handler function. ***** Only for the "table" window *****
/*  joyleft
    joyright
    joyup
    joydown
    joyselect
    joymenu
    joycollectionmenu
*/
async function handleInput(input) {
    if (isAnimating) return; // Prevent rapid inputs during animation
    markUserActivity();

    switch (input) {
        case "joyleft":
            isAnimating = true;
            if (isCollectionMode()) {
                currentCollectionIndex = wrapIndex(currentCollectionIndex - 1, collectionEntries.length);
            } else {
                currentTableIndex = wrapIndex(currentTableIndex - 1, vpin.tableData.length);
            }
            updateScreen('left');

            // tell other windows the table index changed
            if (!isCollectionMode()) {
                vpin.sendMessageToAllWindows({
                    type: 'TableIndexUpdate',
                    index: currentTableIndex
                });
            }
            break;
        case "joyright":
            isAnimating = true;
            if (isCollectionMode()) {
                currentCollectionIndex = wrapIndex(currentCollectionIndex + 1, collectionEntries.length);
            } else {
                currentTableIndex = wrapIndex(currentTableIndex + 1, vpin.tableData.length);
            }
            updateScreen('right');

            // tell other windows the table index changed
            if (!isCollectionMode()) {
                vpin.sendMessageToAllWindows({
                    type: 'TableIndexUpdate',
                    index: currentTableIndex
                });
            }
            break;
        case "joyselect":
            if (isCollectionMode()) {
                await selectCurrentCollection();
                break;
            }
            attractSuspended = true;
            stopAttractMode();
            tableAudio.stop();
            vpin.sendMessageToAllWindows({ type: "TableLaunching" });
            vpin.launchTable(currentTableIndex); // fire and forget — TableRunning/TableLaunchComplete arrive via events
            await fadeOut();
            break;
        case "joyback":
            await toggleCollectionMode();
            break;
    }
}

// Update the main BG image with smooth transition
function updateBGImage() {
    const container = document.getElementById('bgImageContainer');
    if (!container) return; // Window may not have this element

    const oldImg = container.querySelector('img');

    if (!vpin.tableData || vpin.tableData.length === 0) {
        // Clear background image when no tables
        container.innerHTML = '';
        return;
    }

    const bgUrl = vpin.getImageURL(currentTableIndex, "bg");

    if (oldImg) {
        oldImg.style.opacity = '0';
        setTimeout(() => {
            oldImg.src = bgUrl;
            oldImg.style.opacity = '1';
        }, 300);
    } else {
        const img = document.createElement('img');
        img.src = bgUrl;
        img.style.opacity = '0';
        img.onload = () => {
            requestAnimationFrame(() => {
                img.style.opacity = '1';
            });
        };
        container.appendChild(img);
    }
}

// Update DMD image for DMD window
function updateDMDImage() {
    const container = document.getElementById('dmdImageContainer');
    if (!container) return; // Window may not have this element

    const oldImg = container.querySelector('img');

    if (!vpin.tableData || vpin.tableData.length === 0) {
        // Clear DMD image when no tables
        container.innerHTML = '';
        return;
    }

    const dmdUrl = vpin.getImageURL(currentTableIndex, "dmd");

    if (oldImg) {
        oldImg.style.opacity = '0';
        setTimeout(() => {
            oldImg.src = dmdUrl;
            oldImg.style.opacity = '1';
        }, 300);
    } else {
        const img = document.createElement('img');
        img.src = dmdUrl;
        img.style.opacity = '0';
        img.onload = () => {
            requestAnimationFrame(() => {
                img.style.opacity = '1';
            });
        };
        container.appendChild(img);
    }
}

// Update table information text
// Update table information text
function updateTableInfo() {
    if (isCollectionMode()) {
        updateCollectionInfo();
        return;
    }

    if (!vpin.tableData || vpin.tableData.length === 0) {
        // Clear table info when no tables
        const nameEl = document.getElementById('tableName');
        const metaEl = document.getElementById('tableMeta');
        const authorsEl = document.getElementById('authorsText');
        if (nameEl) nameEl.textContent = 'No tables found';
        if (metaEl) metaEl.textContent = '';
        if (authorsEl) authorsEl.textContent = '';
        return;
    }

    const table = vpin.getTableMeta(currentTableIndex);
    const nameEl = document.getElementById('tableName');
    const metaEl = document.getElementById('tableMeta');
    const authorsEl = document.getElementById('authorsText');

    const info = table?.meta?.Info || {};
    const vpx = table?.meta?.VPXFile || {};

    // Get table name from Info.Title first, fallback to filename
    const tableName = info.Title || vpx.filename || table?.tableDirName || 'Unknown Table';

    // Get manufacturer and year from Info first, fallback to VPXFile
    const manufacturer = info.Manufacturer || vpx.manufacturer || 'Unknown';
    const year = info.Year || vpx.year || '';

    nameEl.textContent = tableName;
    metaEl.textContent = manufacturer + (year ? ' • ' + year : '');

    // Get authors from Info.Authors (array) or fallback
    let authors = 'Unknown';
    if (Array.isArray(info.Authors) && info.Authors.length > 0) {
        authors = info.Authors.join(', ');
    }

    if (authorsEl) {
        authorsEl.textContent = authors;

        // Dynamically adjust authors font size based on text length
        const authorsLength = authors.length;
        let authorsFontSize;
        if (authorsLength <= 20) {
            authorsFontSize = '2vw';
        } else if (authorsLength <= 30) {
            authorsFontSize = '1.8vw';
        } else if (authorsLength <= 40) {
            authorsFontSize = '1.6vw';
        } else if (authorsLength <= 50) {
            authorsFontSize = '1.4vw';
        } else {
            authorsFontSize = '1.2vw';
        }
        authorsEl.style.fontSize = authorsFontSize;
    }

    // Dynamically adjust font size for table name
    const textLength = tableName.length;
    let fontSize;
    if (textLength <= 20) {
        fontSize = '4vw';
    } else if (textLength <= 30) {
        fontSize = '3.5vw';
    } else if (textLength <= 40) {
        fontSize = '3vw';
    } else if (textLength <= 50) {
        fontSize = '2.5vw';
    } else {
        fontSize = '2vw';
    }
    nameEl.style.fontSize = fontSize;
}

function updateCollectionInfo() {
    const collection = collectionEntries[currentCollectionIndex] || {};
    const nameEl = document.getElementById('tableName');
    const metaEl = document.getElementById('tableMeta');
    const authorsEl = document.getElementById('authorsText');
    const tableCount = Number(collection.table_count);
    const countText = Number.isFinite(tableCount)
        ? tableCount + ' ' + (tableCount === 1 ? 'table' : 'tables')
        : 'Collection';

    if (nameEl) {
        nameEl.textContent = collection.name || 'Collection';
        nameEl.style.fontSize = '4vw';
    }
    if (metaEl) {
        metaEl.textContent = collection.is_filter ? 'Filter collection' : countText;
    }
    if (authorsEl) {
        authorsEl.textContent = countText;
        authorsEl.style.fontSize = '2vw';
    }
}

function parseMaybeJson(value, fallback) {
    if (typeof value !== "string") return value ?? fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function isCollectionMode() {
    return wheelMode === "collections";
}

function getCurrentCarouselIndex() {
    return isCollectionMode() ? currentCollectionIndex : currentTableIndex;
}

function setCurrentCarouselIndex(index) {
    if (isCollectionMode()) {
        currentCollectionIndex = index;
    } else {
        currentTableIndex = index;
    }
}

function getCarouselItemCount() {
    return isCollectionMode() ? collectionEntries.length : (vpin.tableData?.length || 0);
}

function getCarouselWheelUrl(index) {
    if (isCollectionMode()) {
        return collectionEntries[index]?.image_url || "";
    }
    return vpin.getImageURL(index, "wheel");
}

function getCarouselAltText(index) {
    if (isCollectionMode()) {
        return collectionEntries[index]?.name || 'Collection ' + index;
    }
    return 'Table ' + index;
}


// Build the carousel with wheel images
function buildCarousel(direction = null) {
    const track = document.getElementById('carouselTrack');
    const itemCount = getCarouselItemCount();

    if (!itemCount) {
        // Clear carousel when no tables
        track.innerHTML = '';
        isAnimating = false;
        return;
    }

    const visibleItems = Math.min(9, itemCount); // Show up to 9 items
    const sideItems = Math.floor(visibleItems / 2);

    // Get existing items
    const existingItems = Array.from(track.children);

    // If first build, number of items changed, or no direction (collection/filter change), rebuild completely
    if (existingItems.length === 0 || existingItems.length !== visibleItems || direction === null) {
        track.innerHTML = ''; // Clear all existing items
        for (let i = -sideItems; i <= sideItems; i++) {
            const idx = wrapIndex(getCurrentCarouselIndex() + i, itemCount);
            createCarouselItem(idx, i === 0, track);
        }
        isAnimating = false;
    } else if (direction !== null) {
        // Slide one wheel slot, then rebuild around the new selected table.
        animateCarouselShift(track, direction, sideItems, itemCount);
    }

}

function animateCarouselShift(track, direction, sideItems, itemCount) {
    const step = getCarouselStep(track);
    if (!step) {
        updateCarouselItems(Array.from(track.children), sideItems, itemCount, false);
        isAnimating = false;
        return;
    }

    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';
    track.style.width = `${track.getBoundingClientRect().width}px`;
    track.style.justifyContent = 'flex-start';

    if (direction === 'right') {
        const nextEdgeIndex = wrapIndex(getCurrentCarouselIndex() + sideItems, itemCount);
        createCarouselItem(nextEdgeIndex, false, track);
        updateCarouselSelection(track, sideItems + 1);

        requestAnimationFrame(() => {
            track.style.transition = `transform ${carouselAnimationMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
            track.style.transform = `translateX(${-step}px)`;
        });
    } else if (direction === 'left') {
        const previousEdgeIndex = wrapIndex(getCurrentCarouselIndex() - sideItems, itemCount);
        const newItem = createCarouselItem(previousEdgeIndex, false);
        track.insertBefore(newItem, track.firstChild);
        track.style.transform = `translateX(${-step}px)`;
        updateCarouselSelection(track, sideItems);

        requestAnimationFrame(() => {
            track.style.transition = `transform ${carouselAnimationMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
            track.style.transform = 'translateX(0)';
        });
    } else {
        updateCarouselItems(Array.from(track.children), sideItems, itemCount, false);
        isAnimating = false;
        return;
    }

    let finished = false;
    const finishShift = () => {
        if (finished) return;
        finished = true;
        track.removeEventListener('transitionend', finishShift);
        track.style.transition = 'none';
        track.style.transform = 'translateX(0)';
        rebuildCarouselItems(track, sideItems, itemCount);
        track.style.width = '';
        track.style.justifyContent = '';
        isAnimating = false;
    };

    track.addEventListener('transitionend', finishShift, { once: true });
    setTimeout(finishShift, carouselAnimationMs + 80);
}

function getCarouselStep(track) {
    const first = track.children[0];
    if (!first) return 0;

    const itemWidth = first.getBoundingClientRect().width;
    const styles = window.getComputedStyle(track);
    const gap = parseFloat(styles.columnGap || styles.gap) || 0;
    return itemWidth + gap;
}

function updateCarouselSelection(track, selectedIndex) {
    Array.from(track.children).forEach((item, index) => {
        item.classList.toggle('selected', index === selectedIndex);
        item.classList.remove('jiggle');
    });
}

function rebuildCarouselItems(track, sideItems, itemCount) {
    track.innerHTML = '';
    for (let i = -sideItems; i <= sideItems; i++) {
        const idx = wrapIndex(getCurrentCarouselIndex() + i, itemCount);
        createCarouselItem(idx, i === 0, track);
    }
}

// Update carousel items in place
function updateCarouselItems(existingItems, sideItems, itemCount, animated = false) {
    existingItems.forEach((item, index) => {
        const offset = index - sideItems;
        const idx = wrapIndex(getCurrentCarouselIndex() + offset, itemCount);
        const wheelUrl = getCarouselWheelUrl(idx);

        // Update selected class
        if (offset === 0) {
            item.classList.add('selected');

            // Add jiggle animation when animated
            if (animated) {
                // Remove jiggle first in case it's already there
                item.classList.remove('jiggle');

                // Use requestAnimationFrame to ensure the removal is processed
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        item.classList.add('jiggle');

                        // Remove jiggle class after animation completes
                        setTimeout(() => {
                            item.classList.remove('jiggle');
                        }, carouselAnimationMs);
                    });
                });
            }
        } else {
            item.classList.remove('selected');
            item.classList.remove('jiggle');
        }

        // Update image
        const img = item.querySelector('img');
        if (img && img.src !== wheelUrl) {
            img.src = wheelUrl;
            img.alt = getCarouselAltText(idx);
        }
    });

    // If animated, wait for CSS transition to complete
    if (animated) {
        setTimeout(() => {
            isAnimating = false;
        }, carouselAnimationMs);
    }
}

// Helper function to create a carousel item
function createCarouselItem(idx, isSelected, track) {
    const wheelUrl = getCarouselWheelUrl(idx);

    const item = document.createElement('div');
    item.className = 'carousel-item';
    if (isSelected) {
        item.classList.add('selected');
    }

    if (wheelUrl) {
        const img = document.createElement('img');
        img.src = wheelUrl;
        img.alt = getCarouselAltText(idx);

        // Handle missing images
        img.onerror = () => {
            const placeholder = document.createElement('div');
            placeholder.className = 'missing-placeholder';
            placeholder.textContent = getCarouselAltText(idx);
            item.innerHTML = '';
            item.appendChild(placeholder);
        };

        item.appendChild(img);
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'missing-placeholder';
        placeholder.textContent = getCarouselAltText(idx);
        item.appendChild(placeholder);
    }

    if (track) track.appendChild(item);
    return item;
}

// Main update function
function updateScreen(direction = null) {
    // Update based on window type
    if (windowName === "table") {
        updateBGImage();
        updateTableInfo();
        buildCarousel(direction);
        // Play audio for the selected table
        tableAudio.play(vpin.getAudioURL(currentTableIndex));
    } else if (windowName === "bg") {
        updateBGImage();
    } else if (windowName === "dmd") {
        updateDMDImage();
    }
}

// Smooth fade transition - wait for CSS transition to complete
async function fadeOut() {
    const fadeContainer = document.getElementById('fadeContainer');

    return new Promise(resolve => {
        fadeContainer.addEventListener('transitionend', e => {
            if (e.propertyName === 'opacity') resolve();
        }, { once: true });

        fadeContainer.style.opacity = '0';
    });
}

function fadeIn() {
    const fadeContainer = document.getElementById('fadeContainer');
    fadeContainer.style.opacity = '1';
}

// Remote launch overlay functions
function showRemoteLaunchOverlay(tableName) {
    const overlay = document.getElementById('remote-launch-overlay');
    const nameEl = document.getElementById('remote-launch-table-name');
    if (overlay && nameEl) {
        nameEl.textContent = tableName || 'Unknown Table';
        overlay.style.display = 'flex';
    }
}

function hideRemoteLaunchOverlay() {
    const overlay = document.getElementById('remote-launch-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function clearAttractTimers() {
    if (attractIdleTimer) {
        clearTimeout(attractIdleTimer);
        attractIdleTimer = null;
    }
    if (attractAdvanceTimer) {
        clearTimeout(attractAdvanceTimer);
        attractAdvanceTimer = null;
    }
}

function stopAttractMode() {
    attractModeActive = false;
    clearAttractTimers();
}

function shouldPauseAttractMode() {
    return (
        windowName !== "table" ||
        attractSuspended ||
        isCollectionMode() ||
        !vpin.tableData ||
        vpin.tableData.length < 2 ||
        vpin.menuUP ||
        vpin.collectionMenuUP ||
        vpin.tutorialUP ||
        document.getElementById("remote-launch-overlay")?.style.display === "flex"
    );
}

function queueNextAttractAdvance() {
    if (!attractModeActive) return;
    attractAdvanceTimer = setTimeout(runAttractAdvance, ATTRACT_STEP_MS);
}

function runAttractAdvance() {
    if (!attractModeActive || shouldPauseAttractMode()) {
        stopAttractMode();
        markUserActivity(false);
        return;
    }

    currentTableIndex = wrapIndex(currentTableIndex + 1, vpin.tableData.length);
    isAnimating = true;
    updateScreen('right');
    vpin.sendMessageToAllWindows({
        type: 'TableIndexUpdate',
        index: currentTableIndex
    });
    queueNextAttractAdvance();
}

function startAttractMode() {
    if (shouldPauseAttractMode()) {
        markUserActivity(false);
        return;
    }

    attractModeActive = true;
    runAttractAdvance();
}

function markUserActivity(stopAttract = true) {
    if (windowName !== "table") return;

    clearAttractTimers();
    if (stopAttract) stopAttractMode();
    attractIdleTimer = setTimeout(startAttractMode, ATTRACT_IDLE_MS);
}

function setupAttractMode() {
    ["mousedown", "touchstart", "keydown"].forEach((eventName) => {
        window.addEventListener(eventName, () => markUserActivity(), { passive: true });
    });
}

async function toggleCollectionMode() {
    stopAttractMode();
    if (isCollectionMode()) {
        leaveCollectionMode();
    } else {
        await enterCollectionMode();
    }
}

async function enterCollectionMode() {
    if (windowName !== "table") return;

    const metadata = parseMaybeJson(await vpin.call("get_collections_metadata").catch(() => []), []);
    const namedCollections = Array.isArray(metadata) ? metadata.filter(entry => entry && entry.name) : [];
    collectionEntries = namedCollections;

    if (!collectionEntries.length) return;

    const currentCollection = await vpin.call("get_current_collection").catch(() => "None");
    currentCollectionIndex = currentCollection && currentCollection !== "None"
        ? Math.max(0, collectionEntries.findIndex(entry => entry.name === currentCollection))
        : 0;
    wheelMode = "collections";
    isAnimating = false;
    document.body.classList.add("collection-wheel-mode");
    updateScreen();
}

function leaveCollectionMode() {
    wheelMode = "tables";
    isAnimating = false;
    document.body.classList.remove("collection-wheel-mode");
    updateScreen();
    markUserActivity(false);
}

async function selectCurrentCollection() {
    const collection = collectionEntries[currentCollectionIndex];
    if (!collection?.name) return;

    wheelMode = "tables";
    document.body.classList.remove("collection-wheel-mode");
    stopAttractMode();

    await vpin.call("set_tables_by_collection", collection.name);
    await vpin.getTableData();

    currentTableIndex = 0;
    isAnimating = false;
    updateScreen();
    vpin.sendMessageToAllWindows({
        type: "TableDataChange",
        index: currentTableIndex,
        collection: collection.name
    });
    markUserActivity(false);
}

//
// MISC suuport functions
//

// circular table index
function wrapIndex(index, length) {
    return (index + length) % length;
}
