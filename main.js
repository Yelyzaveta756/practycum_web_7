const sheetBlock = document.getElementById("sheet");

function logEvent(message) {
  console.log("Event:", message);
  // логіка збереження в LocalStorage і надсилання на сервер
}

// Функція для відкриття анімаційного блоку
function openAnimBlock() {
  if (sheetBlock) {
    sheetBlock.style.display = "block";
    logEvent("Animation block open");
  } else {
    console.warn("Element #work not found in DOM");
  }
}

document.getElementById("playBtn").addEventListener("click", openAnimBlock);

// Функція для закривання анімаційного блоку

function closeAnimBlock() {
  if (sheetBlock) {
    sheetBlock.style.display = "none";
    logEvent("Animation block closed");
  }

  let localEvents = [];
  try {
    const stored = localStorage.getItem("animEvents");
    if (stored) {
      localEvents = JSON.parse(stored);
    }
  } catch (e) {
    console.error("Error reading from LocalStorage:", e);
  }

  // додати реальний endpoint
}

document.getElementById("closeBtn").addEventListener("click", closeAnimBlock);
