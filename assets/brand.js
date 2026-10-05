window.nyangkutBrand = `<img class="brand-logo logo-light" src="/assets/logo-nyangkut.png?v=3" alt="Nyangkut" /><img class="brand-logo logo-dark" src="/assets/logo-nyangkut-dark.png?v=3" alt="" aria-hidden="true" />`;

document.querySelectorAll("[data-brand]").forEach((element) => {
  element.innerHTML = window.nyangkutBrand;
});
