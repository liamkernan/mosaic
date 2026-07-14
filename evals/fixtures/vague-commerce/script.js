/* global document */

const products = {
  "clay-lamp": {
    name: "Clay Lamp",
    details: "Warm light through a hand-thrown clay shade. Matte clay, 14 inches tall."
  },
  "linen-throw": {
    name: "Linen Throw",
    details: "A soft woven linen layer for cool evenings. Woven linen, 50 by 70 inches."
  }
};

const cart = [];

function renderCart() {
  const cartCount = document.querySelector("#cartCount");
  const cartItems = document.querySelector("#cartItems");
  cartCount.textContent = String(cart.length);
  cartItems.innerHTML = cart.map((productKey) => `<li>${products[productKey].name}</li>`).join("");
}

function addToCart(productKey) {
  cart.push(productKey);
  renderCart();
}

document.querySelectorAll(".add-to-cart").forEach((button) => {
  button.addEventListener("click", () => addToCart(button.dataset.productKey));
});

document.querySelector("#cartButton").addEventListener("click", () => {
  const drawer = document.querySelector("#cartDrawer");
  const opening = drawer.hidden;
  drawer.hidden = !opening;
  document.querySelector("#cartButton").setAttribute("aria-expanded", String(opening));
});

document.querySelectorAll(".quick-view").forEach((button) => {
  button.addEventListener("click", () => {
    const product = products["clay-lamp"];
    document.querySelector("#quickViewTitle").textContent = product.name;
    document.querySelector("#quickViewDetails").textContent = product.details;
    document.querySelector("#quickViewPanel").classList.add("is-open");
  });
});
