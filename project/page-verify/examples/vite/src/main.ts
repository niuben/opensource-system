const count = document.querySelector<HTMLElement>('[data-testid="count"]')!;
const increment = document.querySelector<HTMLButtonElement>('[data-testid="increment"]')!;
const raiseError = document.querySelector<HTMLButtonElement>('[data-testid="raise-error"]')!;

increment.addEventListener("click", () => {
  count.textContent = String(Number(count.textContent) + 1);
});

raiseError.addEventListener("click", () => {
  queueMicrotask(() => {
    throw new Error("Intentional Page Probe demo error");
  });
});
