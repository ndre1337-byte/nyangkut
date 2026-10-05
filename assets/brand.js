window.nyangkutBrand = `<img class="brand-logo" src="/assets/logo-nyangkut.png?v=2" alt="Nyangkut" />`;

document.querySelectorAll("[data-brand]").forEach((element) => {
  element.innerHTML = window.nyangkutBrand;
});
