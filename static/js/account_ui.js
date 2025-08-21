// Account Management UI Enhancements
// - Drag & drop upload for profile photo
// - Password strength meter and visibility toggle
// - Live confirm-password validation

(function () {
  document.addEventListener('DOMContentLoaded', function () {
    // --- Profile photo drag & drop ---
    var dropzone = document.getElementById('photo-dropzone');
    var fileInput = document.getElementById('profile_photo');

    if (dropzone && fileInput) {
      var highlight = function (on) {
        dropzone.style.borderColor = on ? '#3a7bd5' : '#dee2e6';
        dropzone.style.background = on ? '#eef5ff' : '#f8f9fa';
      };

      // Click to open file chooser
      dropzone.addEventListener('click', function () {
        fileInput.click();
      });

      // Drag events
      ['dragenter', 'dragover'].forEach(function (evt) {
        dropzone.addEventListener(evt, function (e) {
          e.preventDefault();
          e.stopPropagation();
          highlight(true);
        });
      });

      ;['dragleave', 'drop'].forEach(function (evt) {
        dropzone.addEventListener(evt, function (e) {
          e.preventDefault();
          e.stopPropagation();
          highlight(false);
        });
      });

      dropzone.addEventListener('drop', function (e) {
        var dt = e.dataTransfer;
        if (!dt || !dt.files || !dt.files.length) return;
        var file = dt.files[0];
        // Assign to input so form submits it
        var dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        // Trigger preview
        if (typeof previewProfilePhoto === 'function') {
          previewProfilePhoto(fileInput);
        }
      });
    }

    // --- Password visibility toggles ---
    document.querySelectorAll('.toggle-visibility').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var targetSel = btn.getAttribute('data-target');
        if (!targetSel) return;
        
        console.log('Toggle clicked for:', targetSel);
        
        var input = document.querySelector(targetSel);
        if (!input) {
          console.error('Target input not found:', targetSel);
          return;
        }
        
        var isPassword = input.getAttribute('type') === 'password';
        input.setAttribute('type', isPassword ? 'text' : 'password');
        btn.innerHTML = isPassword ? '<i class="bi bi-eye-slash"></i>' : '<i class="bi bi-eye"></i>';
        
        console.log('Toggled visibility for', targetSel, 'to', input.getAttribute('type'));
      });
    });
    
    // Direct binding for change_new_password field to ensure it works
    var newPasswordToggle = document.querySelector('button[data-target="#change_new_password"]');
    var newPasswordInput = document.getElementById('change_new_password');
    
    if (newPasswordToggle && newPasswordInput) {
      newPasswordToggle.addEventListener('click', function() {
        var isPassword = newPasswordInput.getAttribute('type') === 'password';
        newPasswordInput.setAttribute('type', isPassword ? 'text' : 'password');
        newPasswordToggle.innerHTML = isPassword ? '<i class="bi bi-eye-slash"></i>' : '<i class="bi bi-eye"></i>';
        console.log('Direct toggle for change_new_password to', newPasswordInput.getAttribute('type'));
      });
    } else {
      console.error('Could not find change_new_password elements:', !!newPasswordToggle, !!newPasswordInput);
    }

    // Change-password UI removed
    var newPwd = null;
    var strengthBar = null;
    var strengthText = null;

    // Confirm password UI removed
    var confirmPwd = null;
    var form = null;
    var confirmFeedback = null;
  });
})();