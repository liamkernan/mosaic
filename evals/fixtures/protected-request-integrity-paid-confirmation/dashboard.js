/* global document */

const watchButton = document.querySelector("#watchIncident");
const watchStatus = document.querySelector("#watchStatus");

watchButton.addEventListener("click", () => {
  const watching = watchButton.dataset.watching !== "true";
  watchButton.dataset.watching = String(watching);
  watchStatus.textContent = watching ? "Watching incident" : "Not watching";
});

function setDetailsOpen(open) {
  document.querySelector("#detailsPanel").hidden = !open;
}

document.querySelector("#detailsToggle").addEventListener("click", () => {
  const panel = document.querySelector("#detailsPanel");
  setDetailsOpen(panel.hidden);
});

document.querySelector("#detailsClose").addEventListener("click", () => {
  setDetailsOpen(false);
});
