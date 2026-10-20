// Tiny stand-in for a theme script: gallery thumbnails, Ajax add to cart, lazy reviews. Made-up store, offline use only.
(function () {
  var gallery = document.getElementById('gallery');
  document.querySelectorAll('.thumbnail').forEach(function (b) {
    b.addEventListener('click', function () { var i = +b.getAttribute('data-i'); gallery.scrollTo({ left: gallery.clientWidth * i, behavior: 'instant' }); });
  });
  var form = document.getElementById('product-form');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var size = form.querySelector('select[name="options[Size]"]');
    var data = new URLSearchParams({ id: size ? size.value : form.querySelector('[name=id]').value, quantity: '1' });
    fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data.toString() })
      .then(function (r) { return r.json(); })
      .then(function () { document.getElementById('cart-notification').style.display = 'block'; });
  });
  var reviews = document.getElementById('reviews');
  if (reviews && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      if (!es.some(function (x) { return x.isIntersecting; })) return;
      io.disconnect();
      fetch('/reviews.json').then(function (r) { return r.json(); }).then(function (j) { reviews.textContent = j.summary + ' ' + j.snippet; });
    });
    io.observe(reviews);
  }
})();
