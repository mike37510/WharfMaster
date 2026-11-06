(() => {
  const els = document.querySelectorAll('.band, .tools, .shots, .api, .close, .feature-list li, .tool-grid article, .shot-card');
  els.forEach((el) => el.classList.add('reveal'));

  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
  );

  els.forEach((el) => io.observe(el));
})();
