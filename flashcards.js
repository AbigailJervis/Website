// ============= CONFIGURATION =============
const WORDS_PER_SESSION = 30;
const QUOTAS = {0: 12, 1: 10, 2: 6, 3: 2};
const DECAY = {grace: 7, max: 14, amount: 1.0, threshold: 14, factor: 0.7};

// ============= STATE =============
let decks = {};
let currentDeck = null;
let sessionQueue = [];
let failedQueue = [];
let currentWord = null;
let masteredCount = 0;
let sessionTotal = 0;
let addingToDeck = null;
let originalWord = null;
let originalTranslation = null;

// ============= INITIALIZATION =============
function loadDecks() {
    try {
        const saved = localStorage.getItem('flashcardDecks');
        if (saved) {
            decks = JSON.parse(saved);
            
            // Migrate ALL words once on load, and store back to the deck
            Object.keys(decks).forEach(deckName => {
                if (decks[deckName].words) {
                    decks[deckName].words = decks[deckName].words.map(w => migrate(w)).filter(w => w);
                }
            });
            saveDecks();
        }
    } catch (e) {
        console.error('Error loading decks:', e);
        decks = {};
    }
    displayDecks();
}

function saveDecks() {
    try {
        localStorage.setItem('flashcardDecks', JSON.stringify(decks));
    } catch (e) {
        console.error('Error saving decks:', e);
    }
}

// ============= HELPERS =============
function shuffleArray(arr) {
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function daysSince(date) {
    if (!date) return 0;
    return (new Date() - new Date(date)) / (1000 * 60 * 60 * 24);
}

function isDue(word) {
    if (!word.lastReviewed) return true;
    return daysSince(word.lastReviewed) >= word.interval;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJs(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function csvEscape(str) {
    const s = String(str);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function migrate(word) {
    if (!word) return null;
    
    return {
        word: word.word || '',
        translation: word.translation || '',
        status: word.status !== undefined ? word.status : 
                (word.timesReviewed === 0 ? 0 : 
                 word.timesReviewed <= 2 ? 1 : 
                 word.timesReviewed <= 5 ? 2 : 3),
        ease: word.easeFactor !== undefined ? word.easeFactor : 
              (word.ease !== undefined ? word.ease : 2.5),
        interval: word.interval !== undefined ? word.interval : 0,
        lastReviewed: word.lastReviewed || null,
        times: word.timesReviewed !== undefined ? word.timesReviewed : 
               (word.times !== undefined ? word.times : 0),
        added: word.dateAdded || word.added || new Date().toISOString()
    };
}

function applyDecay(word) {
    if (!word.lastReviewed) return word;
    
    const days = daysSince(word.lastReviewed);
    
    if (days > DECAY.grace) {
        const progress = Math.min((days - DECAY.grace) / (DECAY.max - DECAY.grace), 1);
        word.ease = Math.max(1.3, word.ease - DECAY.amount * progress);
        
        if (days > DECAY.threshold) {
            word.interval = Math.max(1, Math.round(word.interval * DECAY.factor));
        }
        
        if (word.ease < 1.5 && word.status > 1) {
            word.status--;
        }
    }
    
    return word;
}

// ============= WORD SELECTION =============
function selectWordsForSession(deck) {
    // Apply decay in-place (mutates the original word objects)
    deck.words.forEach(w => {
        if (!w.status && w.status !== 0) {
            Object.assign(w, migrate(w));
        }
        applyDecay(w);
    });
    
    const words = deck.words.filter(w => w && w.word);
    
    // Group by status
    const groups = {
        0: [],
        1: [],
        2: [],
        3: []
    };
    
    words.forEach(w => {
        if (groups[w.status]) {
            groups[w.status].push(w);
        }
    });
    
    // Shuffle each group
    [0, 1, 2, 3].forEach(s => {
        groups[s] = shuffleArray(groups[s]);
    });
    
    let selected = [];
    let remaining = WORDS_PER_SESSION;
    
    // Fill quotas
    [0, 1, 2, 3].forEach(status => {
        if (remaining <= 0) return;
        
        const quota = QUOTAS[status];
        const available = groups[status].length;
        const toTake = Math.min(quota, available, remaining);
        
        if (toTake > 0) {
            const picked = weightedPick(groups[status], toTake, status);
            selected = selected.concat(picked);
            remaining -= picked.length;
        }
    });
    
    // Fill remaining slots
    if (remaining > 0) {
        const selectedWords = new Set(selected.map(w => w.word));
        const allRemaining = words.filter(w => !selectedWords.has(w.word));
        const shuffled = shuffleArray(allRemaining);
        selected = selected.concat(shuffled.slice(0, remaining));
    }
    
    return selected;
}

function weightedPick(words, count, status) {
    if (words.length <= count) return words;
    
    const weights = words.map(w => {
        let weight = 1;
        
        if (status === 0) {
            weight = Math.min(daysSince(w.added), 30) * (0.8 + Math.random() * 0.4);
        } else if (status === 1) {
            weight = (isDue(w) ? 50 : 0) + 
                     (3.5 - w.ease) * 10 + 
                     Math.min(daysSince(w.lastReviewed), 20) * 
                     (0.7 + Math.random() * 0.6);
        } else if (status === 2) {
            weight = (isDue(w) ? 40 : 0) + 
                     (3 - w.ease) * 5 + 
                     Math.min(daysSince(w.lastReviewed), 30) * 
                     (0.5 + Math.random());
        } else if (status === 3) {
            weight = (isDue(w) ? 30 : 0) * (0.2 + Math.random() * 1.6);
        }
        
        return { word: w, weight: Math.max(1, weight) };
    });
    
    weights.sort((a, b) => b.weight - a.weight);
    
    const topCount = Math.ceil(count * 0.7);
    const randomCount = count - topCount;
    
    const topWords = weights.slice(0, topCount).map(x => x.word);
    const remainingWords = weights.slice(topCount).map(x => x.word);
    
    const selected = shuffleArray(topWords).slice(0, topCount);
    if (randomCount > 0 && remainingWords.length > 0) {
        selected.push(...shuffleArray(remainingWords).slice(0, randomCount));
    }
    
    return shuffleArray(selected);
}

// ============= SRS UPDATE =============
function updateWord(word, rating) {
    if (rating === 4) {
        word.status = Math.max(0, word.status - 1);
        word.ease = Math.max(1.3, word.ease - 0.3);
        word.interval = 0;
        return;
    }
    
    word.times++;
    
    if (rating === 1) {
        if (word.status === 0) {
            word.status = 1;
            word.interval = 4;
            word.ease = Math.max(2.5, word.ease + 0.3);
        } else if (word.status === 1 && word.times >= 2) {
            word.status = 2;
            word.interval = 7;
            word.ease = Math.max(2.8, word.ease + 0.2);
        } else if (word.status === 2 && word.times >= 4) {
            word.status = 3;
            word.interval = 14;
            word.ease = Math.max(3.0, word.ease + 0.15);
        } else {
            word.interval = Math.round(word.interval * word.ease * 2);
            word.ease += 0.15;
        }
    } else if (rating === 2) {
        if (word.status === 0) {
            word.status = 1;
            word.interval = 2;
        } else if (word.status === 1 && word.times >= 3) {
            word.status = 2;
            word.interval = 5;
        } else if (word.status === 2 && word.times >= 5) {
            word.status = 3;
            word.interval = 10;
        } else {
            word.interval = Math.round(word.interval * word.ease * 1.5);
            word.ease += 0.05;
        }
    } else {
        if (word.status === 0) {
            word.status = 1;
            word.interval = 1;
        }
        word.interval = Math.round(word.interval * 1.2);
        word.ease = Math.max(1.3, word.ease - 0.15);
    }
    
    word.interval = Math.max(1, word.interval);
    word.lastReviewed = new Date().toISOString();
}

// ============= DECK MANAGEMENT =============
function wordExists(deck, word, translation) {
    return deck.words.some(w => w.word === word && w.translation === translation);
}

function displayDecks() {
    const deckList = document.getElementById('deckList');
    if (!deckList) return;
    
    deckList.innerHTML = '';
    
    if (Object.keys(decks).length === 0) {
        deckList.innerHTML = '<div class="empty-state">No decks yet. Upload a CSV or create one above!</div>';
        return;
    }
    
    for (const [deckName, deck] of Object.entries(decks)) {
        const total = deck.words.length;
        const newCount = deck.words.filter(w => w.status === 0).length;
        const learningCount = deck.words.filter(w => w.status === 1).length;
        const knownCount = deck.words.filter(w => w.status === 2).length;
        const masteredCount = deck.words.filter(w => w.status === 3).length;
        
        const deckCard = document.createElement('div');
        deckCard.className = 'deck-card';
        deckCard.innerHTML = `
            <h3>${escapeHtml(deckName)}</h3>
            <div class="deck-stats">
                Total: ${total} | New: ${newCount} | Learning: ${learningCount}<br>
                Known: ${knownCount} | Mastered: ${masteredCount}
            </div>
            <div class="deck-actions">
                <button class="study-btn" onclick="studyDeck('${escapeJs(deckName)}')">Study</button>
                <button class="add-words-btn-small" onclick="showAddWords('${escapeJs(deckName)}')">Add Words</button>
                <button class="export-btn" onclick="exportDeck('${escapeJs(deckName)}')">Export</button>
                <button class="delete-btn" onclick="deleteDeck('${escapeJs(deckName)}')">Delete</button>
            </div>
        `;
        
        deckList.appendChild(deckCard);
    }
}

function parseCSV(csv) {
    const lines = csv.split('\n').filter(line => line.trim());
    if (lines.length < 2) return [];
    
    const headers = lines[0].toLowerCase().split(',');
    const wordIndex = headers.findIndex(h => h.includes('word') || h.includes('term'));
    const translationIndex = headers.findIndex(h => h.includes('translation') || h.includes('definition'));
    
    if (wordIndex === -1 || translationIndex === -1) {
        alert('CSV must have "word" and "translation" columns');
        return [];
    }
    
    const result = [];
    
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',');
        if (values.length >= 2 && values[wordIndex] && values[translationIndex]) {
            result.push({
                word: values[wordIndex].trim(),
                translation: values[translationIndex].trim(),
                status: 0,
                ease: 2.5,
                interval: 0,
                lastReviewed: null,
                times: 0,
                added: new Date().toISOString()
            });
        }
    }
    
    return result;
}

function createDeck() {
    const nameInput = document.getElementById('newDeckName');
    const wordsInput = document.getElementById('newDeckWords');
    
    if (!nameInput || !wordsInput) {
        alert('Error: Input fields not found');
        return;
    }
    
    const name = nameInput.value.trim();
    const text = wordsInput.value.trim();
    
    if (!name) {
        alert('Please enter a deck name');
        return;
    }
    
    if (!text) {
        alert('Please enter some words');
        return;
    }
    
    const words = parseCSV('word,translation\n' + text);
    
    if (words.length === 0) {
        alert('Invalid word format. Use: word,translation on each line');
        return;
    }
    
    if (decks[name]) {
        const added = words.filter(w => !wordExists(decks[name], w.word, w.translation));
        decks[name].words.push(...added);
        alert(`Added ${added.length} new words to "${name}"`);
    } else {
        decks[name] = {
            words: words,
            createdAt: new Date().toISOString(),
            lastStudied: null
        };
        alert(`Created deck "${name}" with ${words.length} words!`);
    }
    
    saveDecks();
    displayDecks();
    
    nameInput.value = '';
    wordsInput.value = '';
}

function showAddWords(deckName) {
    addingToDeck = deckName;
    document.getElementById('addWordsDeckName').textContent = deckName;
    document.getElementById('addWordsSection').style.display = 'block';
    document.getElementById('addWordsText').value = '';
    document.getElementById('addWordsText').focus();
}

function addWordsToDeck() {
    if (!addingToDeck) return;
    
    const text = document.getElementById('addWordsText').value.trim();
    
    if (!text) {
        alert('Please enter some words to add');
        return;
    }
    
    const words = parseCSV('word,translation\n' + text);
    
    if (words.length === 0) {
        alert('Invalid word format');
        return;
    }
    
    const deck = decks[addingToDeck];
    const added = words.filter(w => !wordExists(deck, w.word, w.translation));
    
    deck.words.push(...added);
    saveDecks();
    displayDecks();
    
    document.getElementById('addWordsSection').style.display = 'none';
    alert(`Added ${added.length} words to "${addingToDeck}"`);
    addingToDeck = null;
}

function cancelAddWords() {
    addingToDeck = null;
    document.getElementById('addWordsSection').style.display = 'none';
}

function deleteDeck(deckName) {
    if (confirm(`Delete deck "${deckName}"?`)) {
        delete decks[deckName];
        saveDecks();
        displayDecks();
    }
}

function exportDeck(deckName) {
    const deck = decks[deckName];
    if (!deck) return;
    
    let csv = 'word,translation,status,ease_factor,interval,last_reviewed,times_reviewed\n';
    
    deck.words.forEach(w => {
        csv += [
            csvEscape(w.word),
            csvEscape(w.translation),
            w.status,
            w.ease,
            w.interval,
            w.lastReviewed || '',
            w.times
        ].join(',') + '\n';
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${deckName.replace(/[^a-z0-9]/gi, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============= STUDY SESSION =============
function studyDeck(deckName) {
    currentDeck = deckName;
    const deck = decks[deckName];
    
    if (!deck || deck.words.length === 0) {
        alert('This deck has no words to study');
        return;
    }
    
    sessionQueue = selectWordsForSession(deck);
    failedQueue = [];
    masteredCount = 0;
    sessionTotal = sessionQueue.length;
    
    document.getElementById('deckScreen').style.display = 'none';
    document.getElementById('studyScreen').style.display = 'block';
    document.getElementById('currentDeckName').textContent = deckName;
    document.getElementById('buttons').style.display = 'grid';
    
    nextWord();
}

function nextWord() {
    if (sessionQueue.length > 0) {
        currentWord = sessionQueue.pop();
    } else if (failedQueue.length > 0) {
        // Shuffle failed words, ensuring most recent isn't shown next
        if (failedQueue.length === 1) {
            currentWord = failedQueue.pop();
        } else {
            const mostRecent = failedQueue[failedQueue.length - 1];
            failedQueue = shuffleArray(failedQueue);
            
            // If most recent is at the END (which is next to be popped), move it
            if (failedQueue[failedQueue.length - 1] === mostRecent) {
                const swapIndex = Math.floor(Math.random() * (failedQueue.length - 1));
                const lastIndex = failedQueue.length - 1;
                [failedQueue[lastIndex], failedQueue[swapIndex]] = 
                    [failedQueue[swapIndex], failedQueue[lastIndex]];
            }
            
            currentWord = failedQueue.pop();
        }
    } else {
        completeSession();
        return;
    }
    
    document.getElementById('word').textContent = currentWord.word;
    document.getElementById('translation').textContent = currentWord.translation;
    document.getElementById('translation').style.display = 'none';
    
    const statusNames = ['New', 'Learning', 'Known', 'Mastered'];
    document.getElementById('clickHint').textContent = 
        `Click to reveal (${statusNames[currentWord.status] || 'Unknown'})`;
    document.getElementById('clickHint').style.display = 'block';
    
    document.getElementById('editCard').style.display = 'none';
    document.getElementById('flashcard').style.display = 'flex';
    const editBtn = document.querySelector('.edit-btn');
    if (editBtn) editBtn.style.display = 'block';
    
    updateProgress();
}

function revealCard() {
    document.getElementById('translation').style.display = 'block';
    document.getElementById('clickHint').style.display = 'none';
}

function rateWord(rating) {
    if (!currentWord) return;
    
    if (rating === 4) {
        failedQueue.push(currentWord);
        updateWord(currentWord, 4);
    } else {
        updateWord(currentWord, rating);
        masteredCount++;
        decks[currentDeck].lastStudied = new Date().toISOString();
    }
    
    saveDecks();
    nextWord();
}

function updateProgress() {
    let text = `${masteredCount}/${sessionTotal} reviewed`;
    if (failedQueue.length > 0) {
        text += ` (${failedQueue.length} to retry)`;
    }
    document.getElementById('progress').textContent = text;
}

function completeSession() {
    alert('🎉 Session complete! Great job!');
    backToDecks();
}

function backToDecks() {
    document.getElementById('studyScreen').style.display = 'none';
    document.getElementById('deckScreen').style.display = 'block';
    displayDecks();
}

// ============= EDIT FLASHCARD =============
function toggleEdit(event) {
    if (event) event.stopPropagation();
    
    if (!currentWord) return;
    
    originalWord = currentWord.word;
    originalTranslation = currentWord.translation;
    
    document.getElementById('editWord').value = currentWord.word;
    document.getElementById('editTranslation').value = currentWord.translation;
    
    document.getElementById('flashcard').style.display = 'none';
    document.getElementById('editCard').style.display = 'block';
    
    const editBtn = document.querySelector('.edit-btn');
    if (editBtn) editBtn.style.display = 'none';
    
    document.getElementById('editWord').focus();
    document.getElementById('editWord').select();
}

function saveEdit() {
    if (!currentWord) return;
    
    const newWord = document.getElementById('editWord').value.trim();
    const newTranslation = document.getElementById('editTranslation').value.trim();
    
    if (!newWord || !newTranslation) {
        alert('Both fields must be filled in');
        return;
    }
    
    const oldWord = currentWord.word;
    const oldTranslation = originalTranslation;
    
    // Check if this creates a duplicate
    const deck = decks[currentDeck];
    const isDuplicate = deck.words.some(w => 
        w !== currentWord && 
        w.word === newWord && 
        w.translation === newTranslation
    );
    
    if (isDuplicate) {
        if (!confirm(`"${newWord}" with the same translation already exists. Save anyway?`)) {
            return;
        }
    }
    
    // Update the current word object (reference to the deck's word)
    currentWord.word = newWord;
    currentWord.translation = newTranslation;
    
    // Update any duplicates in the queues
    [...sessionQueue, ...failedQueue].forEach(w => {
        if (w !== currentWord && w.word === oldWord && w.translation === oldTranslation) {
            w.word = newWord;
            w.translation = newTranslation;
        }
    });
    
    saveDecks();
    
    document.getElementById('word').textContent = currentWord.word;
    document.getElementById('translation').textContent = currentWord.translation;
    
    closeEdit();
}

function cancelEdit() {
    closeEdit();
}

function closeEdit() {
    document.getElementById('editCard').style.display = 'none';
    document.getElementById('flashcard').style.display = 'flex';
    
    const editBtn = document.querySelector('.edit-btn');
    if (editBtn) editBtn.style.display = 'block';
    
    document.getElementById('translation').style.display = 'none';
    document.getElementById('clickHint').style.display = 'block';
}

// ============= FILE UPLOAD =============
document.addEventListener('DOMContentLoaded', function() {
    const csvUpload = document.getElementById('csvUpload');
    if (csvUpload) {
        csvUpload.addEventListener('change', function(e) {
            const files = e.target.files;
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const deckName = file.name.replace('.csv', '').replace(/_/g, ' ');
                
                const reader = new FileReader();
                
                reader.onload = function(event) {
                    const words = parseCSV(event.target.result);
                    
                    if (words.length === 0) {
                        alert(`Could not parse "${file.name}"`);
                        return;
                    }
                    
                    if (decks[deckName]) {
                        const added = words.filter(w => 
                            !wordExists(decks[deckName], w.word, w.translation)
                        );
                        decks[deckName].words.push(...added);
                        alert(`Added ${added.length} words to "${deckName}"`);
                    } else {
                        decks[deckName] = {
                            words: words,
                            createdAt: new Date().toISOString()
                        };
                        alert(`Created "${deckName}" with ${words.length} words`);
                    }
                    
                    saveDecks();
                    displayDecks();
                };
                
                reader.readAsText(file);
            }
            
            e.target.value = '';
        });
    }
    
    loadDecks();
});

// ============= KEYBOARD SHORTCUTS =============
document.addEventListener('keydown', function(e) {
    const studyScreen = document.getElementById('studyScreen');
    if (studyScreen && studyScreen.style.display === 'block') {
        const editCard = document.getElementById('editCard');
        const isEditing = editCard && editCard.style.display === 'block';
        
        if (isEditing) {
            if (e.key === 'Escape') {
                cancelEdit();
            } else if (e.key === 'Enter') {
                saveEdit();
            }
            return;
        }
        
        if (e.key === ' ' || e.key === 'Space') {
            e.preventDefault();
            revealCard();
        } else if (e.key === '1') {
            rateWord(1);
        } else if (e.key === '2') {
            rateWord(2);
        } else if (e.key === '3') {
            rateWord(3);
        } else if (e.key === '4') {
            rateWord(4);
        }
    }
});

// Initialize if DOM is already loaded
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    loadDecks();
}