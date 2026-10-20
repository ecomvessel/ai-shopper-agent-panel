// Tiny stand-in for a WooCommerce theme script: gallery thumbnails. Made-up store, offline use only.
(function () {
  var gallery = document.getElementById('gallery');
  document.querySelectorAll('.flex-control-thumbs img').forEach(function (t) {
    t.addEventListener('click', function () { gallery.scrollTo({ left: gallery.clientWidth * +t.getAttribute('data-i'), behavior: 'instant' }); });
  });
})();
