"use strict";
const DEFAULT_SETTINGS = { enabled: true, height: 34, opacity: 0.9 };
const enabledInput = document.querySelector("#enabled");
const heightInput = document.querySelector("#height");
const opacityInput = document.querySelector("#opacity");
const heightOutput = document.querySelector("#height-output");
const opacityOutput = document.querySelector("#opacity-output");
function renderValues() {
  heightOutput.value = `${heightInput.value}px`;
  opacityOutput.value = `${Math.round(Number(opacityInput.value) * 100)}%`;
}
function saveSettings() {
  renderValues();
  chrome.storage.sync.set({ enabled: enabledInput.checked, height: Number(heightInput.value), opacity: Number(opacityInput.value) });
}
chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  enabledInput.checked = settings.enabled;
  heightInput.value = settings.height;
  opacityInput.value = settings.opacity;
  renderValues();
});
enabledInput.addEventListener("change", saveSettings);
heightInput.addEventListener("input", saveSettings);
opacityInput.addEventListener("input", saveSettings);

