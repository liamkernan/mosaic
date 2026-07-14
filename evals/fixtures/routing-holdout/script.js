/* global document */

function updateFilterStatus(saved) {
  document.querySelector("#filterStatus").textContent = saved ? "Filter saved" : "Filter not saved";
}

document.querySelector("#saveFilterButton").addEventListener("click", () => {
  const button = document.querySelector("#saveFilterButton");
  const saved = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(saved));
  updateFilterStatus(saved);
});

function setSortPanelOpen(open) {
  document.querySelector("#sortPanel").hidden = !open;
}

document.querySelector("#sortToggle").addEventListener("click", () => {
  const panel = document.querySelector("#sortPanel");
  setSortPanelOpen(panel.hidden);
});

document.querySelector("#sortClose").addEventListener("click", () => {
  setSortPanelOpen(false);
});

document.querySelectorAll(".sort-option").forEach((button) => {
  button.addEventListener("click", () => {
    const orders = [...document.querySelectorAll("#orderList li")];
    const direction = button.dataset.direction;
    orders.sort((left, right) => {
      const comparison = left.dataset.createdAt.localeCompare(right.dataset.createdAt);
      return direction === "oldest" ? comparison : -comparison;
    });
    document.querySelector("#orderList").replaceChildren(...orders);
  });
});
