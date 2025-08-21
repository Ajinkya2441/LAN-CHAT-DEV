let socket = io();
let currentRecipients = null;
let groupUsers = [];

// Store drafts per chat
let chatDrafts = {};

// Track unread senders per group
let groupUnreadSenders = {};

// Track last message time per conversation (user and group)
let lastMessageTimeUser = {};
let lastMessageTimeGroup = {};

// Reorder helpers: put most recent at top
function reorderUserList() {
  const ul = $('#user-list');
  const items = ul.children('li.user-item').get();
  items.sort((a, b) => {
    const ua = $(a).data('user');
    const ub = $(b).data('user');
    const ta = lastMessageTimeUser[ua] || 0;
    const tb = lastMessageTimeUser[ub] || 0;
    return tb - ta; // descending: newest first
  });
  ul.append(items);
}

function reorderGroupList() {
  const gl = $('#group-list');
  const items = gl.children('.group-item').get();
  items.sort((a, b) => {
    const ga = String($(a).data('group-id'));
    const gb = String($(b).data('group-id'));
    const ta = lastMessageTimeGroup[ga] || 0;
    const tb = lastMessageTimeGroup[gb] || 0;
    return tb - ta; // descending: newest first
  });
  gl.append(items);
}

// Update maps from an incoming or outgoing message and reorder lists
function updateConversationOrderForMessage(msg) {
  const t = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
  if (msg.recipients && String(msg.recipients).startsWith('group-')) {
    const gid = String(msg.recipients).split('-')[1];
    if (gid) {
      lastMessageTimeGroup[gid] = Math.max(lastMessageTimeGroup[gid] || 0, t);
      reorderGroupList();
    }
  } else {
    const partner = (msg.sender === USERNAME) ? msg.recipients : msg.sender;
    if (partner && partner !== USERNAME) {
      lastMessageTimeUser[partner] = Math.max(lastMessageTimeUser[partner] || 0, t);
      reorderUserList();
    }
  }
}

// Persist last chat (user or group) across refresh
const LAST_CHAT_KEY = 'lastChatSelection';
let appliedLastChat = false;
function saveLastChat(selection) {
  try { localStorage.setItem(LAST_CHAT_KEY, JSON.stringify(selection)); } catch (e) {}
}
function getLastChat() {
  try { return JSON.parse(localStorage.getItem(LAST_CHAT_KEY) || 'null'); } catch (e) { return null; }
}
function maybeOpenLastChat() {
  if (appliedLastChat) return;
  const last = getLastChat();
  if (!last) return;
  if (last.type === 'user') {
    const $item = $(`#user-list .user-item[data-user='${last.user}']`);
    if ($item.length) {
      $item.trigger('click');
      appliedLastChat = true;
    }
  } else if (last.type === 'group') {
    const $gitem = $(`#group-list .group-item[data-group-id='${last.groupId}']`);
    if ($gitem.length) {
      $gitem.trigger('click');
      appliedLastChat = true;
    }
  }
}

function scrollChatToBottom() {
  let chatBody;
  if (currentRecipients && typeof currentRecipients === 'string' && currentRecipients.startsWith('group-')) {
    chatBody = document.getElementById('group-chat-body');
  } else {
    chatBody = document.getElementById('chat-body');
  }
  if (chatBody) {
    chatBody.scrollTop = chatBody.scrollHeight;
  }
}

// Helper to format UTC timestamp to local time string
function formatLocalTime(utcString) {
  if (!utcString) return '';
  const date = new Date(utcString);
  return date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Helper: get the correct chat body container
function getChatBody() {
  if (currentRecipients && typeof currentRecipients === 'string' && currentRecipients.startsWith('group-')) {
    return $('#group-chat-body');
  } else {
    return $('#chat-body');
  }
}

function renderMessage(msg, isLatest = false) {
  let fileHtml = '';
  if (msg.file) {
    if (msg.file.mimetype.startsWith('image/')) {
      fileHtml = `<div><img src="/uploads/${msg.file.filename}" style="max-width:200px;" class="img-thumbnail"></div>`;
    } else if (msg.file.mimetype.startsWith('video/')) {
      fileHtml = `<div><video controls style="max-width:200px;"><source src="/uploads/${msg.file.filename}" type="${msg.file.mimetype}"></video></div>`;
    } else if (msg.file.mimetype.startsWith('audio/')) {
      fileHtml = `<div><audio controls style='max-width:200px;'><source src="/uploads/${msg.file.filename}" type="${msg.file.mimetype}"></audio></div>`;
    } else {
      fileHtml = `<div><a href="/uploads/${msg.file.filename}" target="_blank">${msg.file.original_name}</a></div>`;
    }
  }
  let msgClass = '';
  let deleteBtn = '';
  // Show delete button for all messages (own and friend's)
  deleteBtn = `<button class='btn btn-link text-danger btn-sm delete-msg-btn' data-msg-id='${msg.id}' title='Delete'><i class='bi bi-trash'></i></button>`;
  // Reply button
  let replyBtn = `<button class='btn btn-link text-primary btn-sm reply-msg-btn' data-msg-id='${msg.id}' title='Reply'><i class='bi bi-reply'></i></button>`;
  // React button
  let reactBtn = `<button class='btn btn-link text-warning btn-sm react-msg-btn' data-msg-id='${msg.id}' title='React'><i class='bi bi-emoji-smile'></i></button>`;
  let ticks = '';
  if (msg.sender === USERNAME) {
    msgClass = 'mine';
    // WhatsApp-like ticks
    if (msg.status === 'read') {
      ticks = `<span class='msg-ticks'><i class='bi bi-check2-all' style='color:#2196f3;font-size:1.2em;'></i></span>`;
    } else {
      ticks = `<span class='msg-ticks'><i class='bi bi-check2' style='color:#222;font-size:1.2em;'></i></span>`;
    }
  } else if (
    (currentRecipients === msg.sender) ||
    (currentRecipients === msg.recipients) ||
    (msg.recipients.split(',').includes(USERNAME) && currentRecipients)
  ) {
    msgClass = 'theirs';
    // Mark as read if not already
    if (msg.status !== 'read') {
      socket.emit('message_read', {msg_id: msg.id});
    }
  }
  if (isLatest) msgClass += ' latest';
  // Show reply preview if this is a reply
  let replyHtml = '';
  if (msg.reply_to) {
    let r = msg.reply_to;
    replyHtml = `<div class='reply-preview border rounded p-1 mb-1' style='background:#f1f1f1;font-size:0.95em;'><b>${r.sender}:</b> ${r.content}</div>`;
  }
  // Show reactions
  let reactionsHtml = '';
  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    reactionsHtml = `<div class='reactions-bar mt-1'>`;
    for (const [emoji, users] of Object.entries(msg.reactions)) {
      let reacted = users.includes(USERNAME) ? 'reacted' : '';
      reactionsHtml += `<span class='reaction ${reacted}' data-msg-id='${msg.id}' data-emoji='${emoji}' title='${users.join(', ')}'>${emoji} <span class='reaction-count'>${users.length}</span></span> `;
    }
    reactionsHtml += `</div>`;
  }
  // Add profile photo for messages from others
  let profilePhotoHtml = '';
  if (msg.sender !== USERNAME) {
    profilePhotoHtml = `<img src="${getProfilePhotoUrl(msg.sender)}" alt="${msg.sender}" class="message-profile-photo" style="width: 35px; height: 35px; border-radius: 50%; object-fit: cover; margin-right: 8px; margin-top: 2px; flex-shrink: 0;" onerror="this.src='/static/img/default_profile.png'">`;
  }
  
  let html = `<div class="message-wrapper ${msgClass === 'theirs' ? 'with-photo' : ''}">
    ${profilePhotoHtml}
    <div class="message ${msgClass}" data-msg-id="${msg.id}" data-content="${(msg.content || '').replace(/"/g, '&quot;')}">
      <div class="msg-header-row">
        <span class="sender">${msg.sender}</span>
        <span class="msg-actions">${replyBtn}${reactBtn}${deleteBtn}</span>
      </div>
      ${replyHtml}
      <div class="msg-content">${msg.content || ''}</div>
      ${fileHtml}
      ${reactionsHtml}
      ${ticks}
    </div>
    <span class="timestamp${isLatest ? ' always' : ''}">${formatLocalTime(msg.timestamp)}</span>
  </div>`;
  getChatBody().append(html);
  scrollChatToBottom();
  // Keep chat list ordered by most recent
  try { updateConversationOrderForMessage(msg); } catch (e) {}
}

function loadHistory(filter) {
  $('#chat-body').html('<div class="text-center text-muted">Loading...</div>');
  $.get('/history', {user: filter}, function(data) {
    $('#chat-body').empty();
    data.forEach(function(msg, idx) {
      renderMessage(msg, idx === data.length - 1);
    });
    // After loading history, update last message time to support search by content later
    if (Array.isArray(data) && data.length) {
      const last = data[data.length - 1];
      try { updateConversationOrderForMessage(last); } catch (e) {}
    }
  });
}

function loadGroupHistory(groupId) {
  $('#group-chat-body').html('<div class="text-center text-muted">Loading group chat...</div>');
  $.get('/history', { group_id: groupId }, function(data) {
    $('#group-chat-body').empty();
    data.forEach(function(msg, idx) {
      renderMessage(msg, idx === data.length - 1);
    });
    // After loading group history, update last message time
    if (Array.isArray(data) && data.length) {
      const last = data[data.length - 1];
      try { updateConversationOrderForMessage(last); } catch (e) {}
    }
    // Scroll to bottom after loading group messages
    setTimeout(scrollChatToBottom, 100);
  });
}

// Helper function to get profile photo URL
function getProfilePhotoUrl(username) {
  // Try to get the actual profile photo, fallback to default if not found
  return `/api/profile_photo/${username}`;
}

// Live update profile photos in UI when a user changes theirs
if (typeof socket !== 'undefined' && socket && socket.on) {
  socket.on('profile_photo_updated', function(data) {
    if (!data || !data.username) return;
    const url = (data.photo_url || getProfilePhotoUrl(data.username)) + '?_=' + Date.now();
    // Update in chat messages (avatars next to messages)
    $(`img.message-profile-photo[alt='${data.username}']`).attr('src', url);
    // Update in user list
    const $userListImg = $(`#user-list .user-item[data-user='${data.username}'] img`);
    if ($userListImg.length) {
      $userListImg.attr('src', url);
    }
    // Update in any open group members/admin lists
    $(`#group-info-members-view img[alt='${data.username}']`).attr('src', url);
    $(`#group-settings-members-list img[alt='${data.username}']`).attr('src', url);
  });
}

// Remove updateUserList(users) and instead use only /users_status as the source of truth
function updateUserListFromStatus(statusList) {
  let ul = $('#user-list');
  ul.empty();
  statusList.forEach(u => {
    if (u.username === USERNAME) return; // Skip current user
    let badge = `<span class="badge bg-danger ms-auto" id="badge-${u.username}" style="display:none;">0</span>`;
    let statusClass = u.online ? 'status-online' : 'status-offline';
    let dot = `<span class="status-dot ${statusClass}"></span>`;
    let profilePhoto = `<img src="${getProfilePhotoUrl(u.username)}" alt="${u.username}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 8px;" onerror="this.src='/static/img/default_profile.png'">`;
    let li = $(`<li class="list-group-item user-item d-flex align-items-center justify-content-between" data-user="${u.username}" data-search-text="${u.username.toLowerCase()}">${profilePhoto}<div class="d-flex align-items-center">${dot}<span class="ms-2">${u.username}</span></div>${badge}</li>`);
    ul.append(li);
  });
  let groupSel = $('#group-users');
  groupSel.empty();
  statusList.forEach(u => {
    if (u.username !== USERNAME) groupSel.append(`<option value="${u.username}">${u.username}</option>`);
  });
  syncMobileSidebar(); // <-- Ensure mobile sidebar is updated
  // After rebuilding the list, apply current ordering
  reorderUserList();
  reorderGroupList();
  // Apply current search filter if any
  try { applyChatSearchFilter(); } catch (e) {}
}

// Notification badge logic
function showBadge(user, sender) {
  if (user !== USERNAME) {
    // Ensure list item and badge exist
    const $item = $(`#user-list .user-item[data-user='${user}']`);
    let badge = $(`#badge-${user}`);
    if (!$item.length) {
      // Try to rebuild user list then retry shortly
      if (typeof window.refreshUsersList === 'function') {
        try { window.refreshUsersList(); } catch (e) {}
      } else {
        // Fallback: fetch /users_status and rebuild minimal entries
        $.get('/users_status', function(users){
          try { updateUserListFromStatus(users); } catch (e) {}
        });
      }
      setTimeout(() => showBadge(user, sender), 300);
      return;
    }
    if (!badge.length) {
      // Create badge and append to item
      badge = $(`<span class="badge bg-danger ms-auto" id="badge-${user}" style="display:none;" data-count="0"></span>`);
      $item.append(badge);
    }
    let count = parseInt(badge.attr('data-count')) || 0;
    count++;
    badge.attr('data-count', count);
    // Show "New" if single unread, otherwise show only the count
    if (count === 1) {
      badge.text('New');
    } else {
      badge.text(String(count));
    }
    badge.show();
    syncMobileSidebar(); // Ensure mobile sidebar badge is updated
    updateChatTabBadge(); // Update chat tab badge
  }
}
function clearBadge(user) {
  let badge = $(`#badge-${user}`);
  badge.attr('data-count', 0);
  badge.text('');
  badge.hide();
  syncMobileSidebar(); // Ensure mobile sidebar badge is updated
  updateChatTabBadge(); // Update chat tab badge
}

// Show badge for group
function showGroupBadge(groupId, sender) {
  let $item = $(`#group-list .group-item[data-group-id='${groupId}']`);
  let badge = $item.find('.group-badge');
  // Create badge if missing
  if (!badge.length) {
    badge = $(`<span class='badge bg-danger ms-auto group-badge' style='display:none;' data-count='0'></span>`);
    $item.append(badge);
  }
  let count = parseInt(badge.attr('data-count')) || 0;
  count++;
  badge.attr('data-count', count);
  // Show "New" if single unread, otherwise show only the count
  if (count === 1) {
    badge.text('New');
  } else {
    badge.text(String(count));
  }
  badge.show();
  syncMobileSidebar(); // Ensure mobile sidebar badge is updated
  updateChatTabBadge(); // Update chat tab badge
}
// Clear badge for group
function clearGroupBadge(groupId) {
  let badge = $(`#group-list .group-item[data-group-id='${groupId}'] .group-badge`);
  badge.attr('data-count', 0);
  badge.text('');
  badge.hide();
  groupUnreadSenders[groupId] = [];
  syncMobileSidebar(); // Ensure mobile sidebar badge is updated
  updateChatTabBadge(); // Update chat tab badge
}

// Typing indicator logic
let typingTimeout;
let lastTypedRecipient = null;
$('#message-input').on('input', function() {
  if (!currentRecipients) return;
  if (lastTypedRecipient !== currentRecipients) {
    lastTypedRecipient = currentRecipients;
  }
  socket.emit('typing', {to: currentRecipients});
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(function() {
    socket.emit('stop_typing', {to: currentRecipients});
  }, 1500);
});

socket.on('show_typing', function(data) {
  if (currentRecipients === data.from || currentRecipients === data.room) {
    if ($('#typing-indicator').length === 0) {
      $('#chat-body').append('<div id="typing-indicator" class="text-muted" style="margin:8px 0 0 8px;">Typing...</div>');
      scrollChatToBottom();
    }
  }
});
socket.on('hide_typing', function(data) {
  $('#typing-indicator').remove();
});

$(function() {
  socket.emit('join', {room: USERNAME});
  $('#chat-body').html('<div class="text-center text-muted">Select a user or group to start chatting.</div>');
  // Use /users_status for initial user list
  $.get('/users_status', updateUserListFromStatus);

  // Listen for user_list and refresh from /users_status
  socket.on('user_list', function() {
    $.get('/users_status', updateUserListFromStatus);
  });

  // --- Real-time search on chats and groups ---
  function normalizeText(t) { return (t || '').toString().toLowerCase(); }
  function itemMatchesQuery($item, query) {
    if (!query) return true;
    const text = ($item.attr('data-search-text') || '').toLowerCase();
    if (text.includes(query)) return true;
    return false;
  }

  // Debounce helper
  function debounce(fn, wait) {
    let t; return function(...args){ clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); };
  }

  // Apply search to user and group lists using both name and server-side message-content match
  const applyChatSearchFilter = debounce(function() {
    const nameQ = normalizeText($('#chat-search-input').val());
    const groupNameQ = normalizeText($('#group-search-input').val());

    // First pass: filter by name locally
    $('#user-list .user-item').each(function() {
      const $it = $(this);
      $it.data('__nameMatch', itemMatchesQuery($it, nameQ));
    });
    $('#group-list .group-item').each(function() {
      const $it = $(this);
      $it.data('__nameMatch', itemMatchesQuery($it, groupNameQ));
    });

    // If both queries empty, just show name matches (which will be true)
    if (!nameQ && !groupNameQ) {
      // Reset highlighting
      clearHighlights($('#user-list .user-item .ms-2'));
      clearHighlights($('#group-list .group-item span'));
      $('#user-list .user-item').each(function(){ $(this).toggle($(this).data('__nameMatch') !== false); });
      $('#group-list .group-item').each(function(){ $(this).toggle($(this).data('__nameMatch') !== false); });
      toggleNoResults();
      return;
    }

    // Fetch server-side matches by message content (single query box for simplicity: chat-search drives both)
    const q = nameQ || groupNameQ;
    $.get('/search', { q: q }, function(resp) {
      const matchedUsers = new Set(resp.users || []);
      const matchedGroups = new Set((resp.groups || []).map(String));

      // Users: show if name match OR message-content match
      $('#user-list .user-item').each(function() {
        const $it = $(this);
        const uname = String($it.data('user'));
        const nameMatch = $it.data('__nameMatch') !== false;
        const contentMatch = matchedUsers.has(uname);
        const show = nameMatch || contentMatch;
        $it.toggle(show);
        // Highlight user name if visible
        const $label = $it.find('.ms-2');
        if (show) highlightMatch($label, nameQ, '#ff0000'); else clearHighlights($label);
      });

      // Groups: show if name match OR message-content match
      $('#group-list .group-item').each(function() {
        const $it = $(this);
        const gid = String($it.data('group-id'));
        const nameMatch = $it.data('__nameMatch') !== false;
        const contentMatch = matchedGroups.has(gid);
        const show = nameMatch || contentMatch;
        $it.toggle(show);
        const $label = $it.find('span').first();
        if (show) highlightMatch($label, groupNameQ, '#ff0000'); else clearHighlights($label);
      });

      // Reorder lists to show matching results on top
      reorderAfterSearch(nameQ, groupNameQ, matchedUsers, matchedGroups);
      toggleNoResults();
      // Auto-scroll to first match (both lists)
      autoScrollToFirstMatch(nameQ, groupNameQ);
    }).fail(function(){
      // On failure, fallback to name-only filtering
      $('#user-list .user-item').each(function(){
        const $it = $(this);
        const show = $(this).data('__nameMatch') !== false;
        $it.toggle(show);
        const $label = $it.find('.ms-2');
        if (show) highlightMatch($label, nameQ, '#ff0000'); else clearHighlights($label);
      });
      $('#group-list .group-item').each(function(){
        const $it = $(this);
        const show = $(this).data('__nameMatch') !== false;
        $it.toggle(show);
        const $label = $it.find('span').first();
        if (show) highlightMatch($label, groupNameQ, '#ff0000'); else clearHighlights($label);
      });
      toggleNoResults();
    });
  }, 150);

  // Simple highlighter helpers
  function clearHighlights($nodes){
    $nodes.each(function(){
      const $el = $(this);
      // unwrap <mark> or span marker by replacing HTML with plain text
      $el.html($el.text());
    });
  }
  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function highlightMatch($node, query, color) {
    const q = (query || '').trim().toLowerCase();
    if (!q){ clearHighlights($node); return; }
    $node.each(function(){
      const $el = $(this);
      const original = $el.text();
      const re = new RegExp('(' + escapeRegExp(q) + ')', 'ig');
      const html = original.replace(re, function(m){ return '<span class="highlight-mark" style="background-color:'+color+'; color:#fff; padding:0 2px; border-radius:2px;">'+m+'</span>'; });
      $el.html(html);
    });
  }

  // Listeners for real-time filtering
  $(document).on('input', '#chat-search-input', applyChatSearchFilter);
  $(document).on('input', '#group-search-input', applyChatSearchFilter);

  // Toggle no-results labels
  function toggleNoResults(){
    const anyUserVisible = $('#user-list .user-item:visible').length > 0;
    const anyGroupVisible = $('#group-list .group-item:visible').length > 0;
    $('#user-no-results').toggle(!anyUserVisible);
    $('#group-no-results').toggle(!anyGroupVisible);
  }

  // Clear both search boxes and fully reset lists, highlighting, and ordering
  function clearSearchAndReset(){
    // Clear inputs
    $('#chat-search-input').val('');
    $('#group-search-input').val('');

    // Remove highlights
    clearHighlights($('#user-list .user-item .ms-2'));
    clearHighlights($('#group-list .group-item span'));

    // Show all items
    $('#user-list .user-item').show();
    $('#group-list .group-item').show();

    // Hide no-results and restore default ordering
    toggleNoResults();
    try { reorderUserList(); } catch (e) {}
    try { reorderGroupList(); } catch (e) {}
  }

  // Also clear search when navigating to a group from results
  $('#group-list').on('click', '.group-item', function(){
    try { clearSearchAndReset(); } catch (e) {}
  });

  // If you have a dedicated handler for group-item clicks (open group chat), also clear search there
  $(document).on('click', '#group-list .group-item', function() {
    // The logic to open group chat likely exists elsewhere; we only clear search.
    try { clearSearchAndReset(); } catch (e) {}
  });

  // Reorder matching results to the top while preserving recency order within groups
  function reorderAfterSearch(nameQ, groupNameQ, matchedUsers, matchedGroups) {
    const qUsers = (nameQ || '').trim().toLowerCase();
    const qGroups = (groupNameQ || '').trim().toLowerCase();

    // Users
    const $userList = $('#user-list');
    const itemsU = $userList.children('li.user-item').get();
    itemsU.sort((a, b) => {
      const $a = $(a), $b = $(b);
      const ua = String($a.data('user')),
            ub = String($b.data('user'));
      const nameMatchA = qUsers && ($a.attr('data-search-text') || '').includes(qUsers);
      const nameMatchB = qUsers && ($b.attr('data-search-text') || '').includes(qUsers);
      const contentMatchA = matchedUsers && matchedUsers.has(ua);
      const contentMatchB = matchedUsers && matchedUsers.has(ub);
      const isMatchA = (nameMatchA || contentMatchA) ? 1 : 0;
      const isMatchB = (nameMatchB || contentMatchB) ? 1 : 0;
      if (isMatchA !== isMatchB) return isMatchB - isMatchA; // matches first
      // If same match status, keep existing recency order using lastMessageTimeUser
      const ta = lastMessageTimeUser[ua] || 0;
      const tb = lastMessageTimeUser[ub] || 0;
      return tb - ta; // newest first
    });
    $userList.append(itemsU);

    // Groups
    const $groupList = $('#group-list');
    const itemsG = $groupList.children('.group-item').get();
    itemsG.sort((a, b) => {
      const $a = $(a), $b = $(b);
      const ga = String($a.data('group-id')),
            gb = String($b.data('group-id'));
      const nameMatchA = qGroups && ($a.attr('data-search-text') || '').includes(qGroups);
      const nameMatchB = qGroups && ($b.attr('data-search-text') || '').includes(qGroups);
      const contentMatchA = matchedGroups && matchedGroups.has(ga);
      const contentMatchB = matchedGroups && matchedGroups.has(gb);
      const isMatchA = (nameMatchA || contentMatchA) ? 1 : 0;
      const isMatchB = (nameMatchB || contentMatchB) ? 1 : 0;
      if (isMatchA !== isMatchB) return isMatchB - isMatchA; // matches first
      // If same match status, keep existing recency order using lastMessageTimeGroup
      const ta = lastMessageTimeGroup[ga] || 0;
      const tb = lastMessageTimeGroup[gb] || 0;
      return tb - ta; // newest first
    });
    $groupList.append(itemsG);
  }

  // Auto-scroll to first matching item in both lists
  function autoScrollToFirstMatch(nameQ, groupNameQ) {
    const qUsers = (nameQ || '').trim().toLowerCase();
    const qGroups = (groupNameQ || '').trim().toLowerCase();

    // Helper to scroll a container to a target element smoothly
    function smoothScrollIntoView($container, $target) {
      if ($container.length === 0 || $target.length === 0) return;
      const c = $container.get(0);
      const t = $target.get(0);
      const top = t.offsetTop - 8; // small padding
      $container.stop().animate({ scrollTop: top }, 200);
    }

    // Users
    const $userContainer = $('#user-list');
    const $firstUser = $userContainer.children('li.user-item:visible').first();
    // Only scroll if there is a query and a visible item
    if ((qUsers || qGroups) && $firstUser.length) {
      smoothScrollIntoView($userContainer, $firstUser);
    }

    // Groups
    const $groupContainer = $('#group-list');
    const $firstGroup = $groupContainer.children('.group-item:visible').first();
    if ((qUsers || qGroups) && $firstGroup.length) {
      smoothScrollIntoView($groupContainer, $firstGroup);
    }
  }

  socket.on('receive_message', function(msg) {
    console.log('📨 Real-time message received:', msg);
    // Update ordering for lists (users/groups) on every incoming message
    try { updateConversationOrderForMessage(msg); } catch (e) {}
    
    // If the message is for the current open chat, render it immediately
    if (
      (currentRecipients === msg.sender && msg.recipients === USERNAME) ||
      (currentRecipients === msg.recipients && msg.sender === USERNAME) ||
      (msg.recipients.split(',').includes(USERNAME) && currentRecipients === msg.sender) ||
      // Fix: show group message in real time if viewing that group
      (currentRecipients && currentRecipients.startsWith('group-') && currentRecipients === msg.recipients)
    ) {
      renderMessage(msg);
    }
    
    // 🔥 CRITICAL: Only show badge if message is TO this user FROM another user (never for own messages)
    if (
      msg.recipients.split(',').includes(USERNAME) &&
      msg.sender !== USERNAME &&
      currentRecipients !== msg.sender
    ) {
      console.log('📱 Showing badge for:', msg.sender);
      showBadge(msg.sender, msg.sender);
    }
    
    // Show group badge if group message from another user and not currently viewing that group
    if (
      msg.recipients.startsWith('group-') &&
      msg.sender !== USERNAME &&
      currentRecipients !== msg.recipients
    ) {
      // Extract group id
      let groupId = msg.recipients.split('-')[1];
      console.log('📱 Showing group badge for group:', groupId);
      showGroupBadge(groupId, msg.sender);
    }
    
    // 🔥 REAL-TIME SIDEBAR UPDATE: Update badges immediately for all relevant messages
    if (msg.sender !== USERNAME) {
      // Only update if the message affects this user
      if (msg.recipients.split(',').includes(USERNAME) || msg.recipients.startsWith('group-')) {
        fetchAndUpdateUnreadCounts();
      }
    }
    
    // Show browser notification if message is for this user and not from self, and window is not focused OR user is in different chat
    if (
      msg.recipients.split(',').includes(USERNAME) &&
      msg.sender !== USERNAME &&
      (!document.hasFocus() || currentRecipients !== msg.sender)
    ) {
      console.log('Attempting to show notification:', msg);
      showBrowserNotification(msg);
    }
    
    // --- In-app notification for mobile ---
    if (
      isMobileView() &&
      msg.sender !== USERNAME &&
      (
        // For user chat: not currently open
        (msg.recipients.split(',').includes(USERNAME) && currentRecipients !== msg.sender) ||
        // For group chat: not currently open
        (msg.recipients.startsWith('group-') && currentRecipients !== msg.recipients)
      )
    ) {
      showInAppNotification(msg);
    }
  });

  socket.on('message_read', function(data) {
    const msgId = data.msg_id;
    // Update all matching ticks in the DOM, even if chat is not open
    $(".message[data-msg-id='" + msgId + "'] .msg-ticks").html("<i class='bi bi-check2-all' style='color:#2196f3;font-size:1.2em;'></i>");
  });

  // 🔥 REAL-TIME: Handle message deletion (complete removal including date/time)
  socket.on('message_deleted', function(data) {
    console.log('Message deleted in real-time:', data);
    
    // Remove the ENTIRE message wrapper (includes message + timestamp) immediately and silently
    $(`.message[data-msg-id='${data.msg_id}']`).closest('.message-wrapper').slideUp(250, function() {
      $(this).remove();
    });
    
    // Update unread counts silently
    fetchAndUpdateUnreadCounts();
  });

  // 🔥 REAL-TIME: Handle chat clearing
  socket.on('chat_cleared', function(data) {
    console.log('Chat cleared in real-time:', data);
    
    if (data.chat_type === 'private') {
      // For private chat clearing - clear silently if viewing this chat
      if ((currentRecipients === data.other_user) || 
          (data.cleared_by === USERNAME && currentRecipients === data.other_user)) {
        
        // Clear chat body immediately and silently
        $('#chat-body').html('<div class="text-center text-muted">Chat was cleared.</div>');
      }
    } else if (data.chat_type === 'group') {
      // For group chat clearing - clear silently if viewing this group
      if (currentRecipients === `group-${data.group_id}`) {
        // Clear group chat body immediately and silently
        $('#chat-body').html('<div class="text-center text-muted">Group chat was cleared.</div>');
      }
    }
    
    // Update unread counts silently
    fetchAndUpdateUnreadCounts();
  });

  // 🔥 REAL-TIME: Handle file deletion
  socket.on('file_deleted', function(data) {
    console.log('File deleted in real-time:', data);
    
    // Remove all messages that referenced this file silently with smooth animation (including timestamps)
    data.affected_messages.forEach(function(msgData) {
      $(`.message[data-msg-id='${msgData.msg_id}']`).closest('.message-wrapper').slideUp(250, function() {
        $(this).remove();
      });
    });
    
    // Remove file from files list if currently viewing files section
    if ($('#files-section').hasClass('active')) {
      loadFilesTable();
    }
    
    // Update unread counts silently
    fetchAndUpdateUnreadCounts();
  });

  function saveCurrentDraft() {
    if (currentRecipients) {
      chatDrafts[currentRecipients] = {
        text: $('#message-input').val(),
        file: $('#file-input')[0].files[0] || null
      };
    }
  }

  function restoreDraftFor(recipient) {
    const draft = chatDrafts[recipient] || {text: '', file: null};
    $('#message-input').val(draft.text || '');
    // Restore file input and preview
    if (draft.file) {
      // Create a DataTransfer to set the file input (works in modern browsers)
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(draft.file);
      $('#file-input')[0].files = dataTransfer.files;
      $('#file-name').text(draft.file.name);
      let preview = '';
      if (draft.file.type.startsWith('image/')) {
        const url = URL.createObjectURL(draft.file);
        preview = `<img src='${url}' style='max-width:40px;max-height:40px;border-radius:6px;margin-left:4px;'>`;
      } else if (draft.file.type.startsWith('video/')) {
        preview = `<i class='bi bi-film' style='font-size:1.3em;margin-left:4px;'></i>`;
      } else if (draft.file.type.includes('pdf')) {
        preview = `<i class='bi bi-file-earmark-pdf' style='font-size:1.3em;margin-left:4px;color:#d32f2f;'></i>`;
      } else if (draft.file.type.includes('zip') || draft.file.type.includes('rar') || draft.file.type.includes('7z')) {
        preview = `<i class='bi bi-file-earmark-zip' style='font-size:1.3em;margin-left:4px;color:#f0ad4e;'></i>`;
      } else if (draft.file.type.startsWith('audio/')) {
        preview = `<i class='bi bi-music-note-beamed' style='font-size:1.3em;margin-left:4px;color:#007bff;'></i>`;
      } else {
        preview = `<i class='bi bi-file-earmark' style='font-size:1.3em;margin-left:4px;'></i>`;
      }
      preview += ` <button type='button' id='cancel-file-btn' class='btn btn-sm btn-outline-danger ms-2' title='Cancel'><i class='bi bi-x'></i></button>`;
      $('#file-preview').html(preview);
    } else {
      // Clear file input and preview
      $('#file-input').val('');
      $('#file-name').text('No file');
      $('#file-preview').html('');
    }
  }

  $('#user-list').on('click', '.user-item', function() {
    saveCurrentDraft();
    // Remove 'active' from all user and group items
    $('#user-list .user-item, #group-list .group-item').removeClass('active animated-select');
    $(this).addClass('active animated-select');
    let user = $(this).data('user');
    if (user === USERNAME) return;
    // Save the current draft before switching
    if (currentRecipients) saveCurrentDraft();
    currentRecipients = user;
    groupUsers = [];
    // Clear any zactive reply state when switching chats
    replyToMsgId = null;
    $('#reply-preview-bar').remove();
    $('#chat-title').text('Chat with ' + user);
    loadHistory(user);
    clearBadge(user);
    restoreDraftFor(user);
    // Persist selection for refresh
    saveLastChat({ type: 'user', user: user });
    // Clear search and reset lists after navigating to chat
    try { clearSearchAndReset(); } catch (e) {}
      // Mark all messages as read for this chat
      $.post('/mark_read', { user: user }, function(resp) {
        if (resp.success) {
          clearBadge(user);
          fetchAndUpdateUnreadCounts();
        }
      });
  });

  $('#start-group').click(function() {
    saveCurrentDraft();
    groupUsers = $('#group-users').val() || [];
    if (groupUsers.length > 0) {
      groupUsers.push(USERNAME);
      groupUsers = [...new Set(groupUsers)].sort();
      let groupRoom = 'group-' + groupUsers.join('-');
      currentRecipients = groupRoom;
      socket.emit('join', {room: groupRoom});
      $('#chat-title').text('Group: ' + groupUsers.filter(u => u !== USERNAME).join(', '));
      loadHistory(groupRoom);
      restoreDraftFor(groupRoom);
      // Persist selection for refresh (ad-hoc groups)
      saveLastChat({ type: 'group', groupId: groupRoom });
    }
  });

  $('#show-history').click(function() {
    loadHistory(USERNAME);
  });

  // Remove ALL previous submit handlers and only use ONE
  $('#message-form').off('submit');
  // Only keep this single handler:
  $('#message-form').on('submit', function(e) {
    e.preventDefault();
    let content = $('#message-input').val();
    let file = $('#file-input')[0].files[0];
    // Prevent sending if all are empty (text, file, audio)
    if (!content && !file && !audioBlob) return;
    let data = {
      recipients: currentRecipients,
      content: content
    };
    if (replyToMsgId) data.reply_to = replyToMsgId;
    if (file) {
      let formData = new FormData();
      formData.append('file', file);
      $('#file-name').text('Uploading...');
      $('#message-form button[type="submit"]').prop('disabled', true);
      $.ajax({
        url: '/upload',
        type: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        success: function(resp) {
          if (resp.file_id) {
            data.file_id = resp.file_id;
            socket.emit('send_message', data);
          } else {
            showPopup({
              title: 'Upload Failed',
              message: 'File upload failed.',
              icon: 'error'
            });
          }
        },
        error: function(xhr) {
          showPopup({
            title: 'Upload Failed',
            message: 'File upload failed: ' + (xhr.responseJSON?.error || 'Unknown error'),
            icon: 'error'
          });
        },
        complete: function() {
          $('#file-input').val('');
          $('#file-name').text('No file');
          $('#file-preview').html('');
          $('#message-input').val('');
          replyToMsgId = null;
          $('#reply-preview-bar').remove();
          $('#message-form button[type="submit"]').prop('disabled', false);
        }
      });
    } else if (audioBlob) {
      let formData = new FormData();
      formData.append('file', audioBlob, 'audio_message.webm');
      $('#audio-record-status').text('Uploading...');
      $.ajax({
        url: '/upload',
        type: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        success: function(resp) {
          if (resp.file_id) {
            data.file_id = resp.file_id;
            socket.emit('send_message', data);
          } else {
            showPopup({
              title: 'Audio Upload Failed',
              message: 'Audio upload failed.',
              icon: 'error'
            });
          }
        },
        error: function(xhr) {
          showPopup({
            title: 'Audio Upload Failed',
            message: 'Audio upload failed: ' + (xhr.responseJSON?.error || 'Unknown error'),
            icon: 'error'
          });
        },
        complete: function() {
          audioBlob = null;
          $('#audio-preview').hide().attr('src', '');
          $('#audio-record-status').hide();
          $('#cancel-audio-btn').remove();
          $('#message-input').val('');
          replyToMsgId = null;
          $('#reply-preview-bar').remove();
        }
      });
    } else {
      console.log('📤 Sending message:', data);
      socket.emit('send_message', data);
      // Optimistically update ordering for the conversation we sent to
      try { updateConversationOrderForMessage({ sender: USERNAME, recipients: currentRecipients, timestamp: new Date().toISOString() }); } catch (e) {}
      $('#message-input').val('');
      $('#file-input').val('');
      $('#file-name').text('No file');
      $('#file-preview').html('');
      replyToMsgId = null;
      $('#reply-preview-bar').remove();
      
      // 🔥 CRITICAL: After sending, ensure no self-badge appears
      setTimeout(() => {
        const recipientUser = currentRecipients;
        const selfBadge = $(`#badge-${USERNAME}`);
        if (selfBadge.length && selfBadge.is(':visible')) {
          console.warn('⚠️ SELF-BADGE DETECTED - This should not happen!');
          clearBadge(USERNAME);
        }
      }, 100);
    }
    if (currentRecipients) chatDrafts[currentRecipients] = {text: '', file: null};
  });

  // Delete message handler with enhanced real-time feedback
  $(document).on('click', '.delete-msg-btn', function() {
    const deleteBtn = $(this);
    const msgId = deleteBtn.data('msg-id');
    const msgDiv = deleteBtn.closest('.message');
    
    showPopup({
      title: 'Delete Message',
      message: 'Are you sure you want to delete this message?',
      icon: 'warning',
      okText: 'Delete',
      cancelText: 'Cancel',
      showCancel: true,
      onOk: function() {
        // 🔥 Show immediate visual feedback
        const originalBtnHtml = deleteBtn.html();
        deleteBtn.html('<i class="bi bi-hourglass-split"></i>').prop('disabled', true);
        msgDiv.closest('.message-wrapper').addClass('opacity-50'); // Fade entire message wrapper (including timestamp)
        
        $.post(`/delete_message/${msgId}`, function(resp) {
          if (resp.success) {
            // For the user who deleted it, remove immediately for instant feedback (including timestamp)
            msgDiv.closest('.message-wrapper').slideUp(200, function() {
              $(this).remove();
            });
            console.log(`Message ${msgId} deleted successfully`);
          } else {
            // Restore visual state on error
            deleteBtn.html(originalBtnHtml).prop('disabled', false);
            msgDiv.closest('.message-wrapper').removeClass('opacity-50');
            showPopup({
              title: 'Delete Failed',
              message: resp.error || 'Delete failed',
              icon: 'error'
            });
          }
        }).fail(function() {
          // Restore visual state on network error
          deleteBtn.html(originalBtnHtml).prop('disabled', false);
          msgDiv.closest('.message-wrapper').removeClass('opacity-50');
          showPopup({
            title: 'Delete Failed',
            message: 'Network error occurred',
            icon: 'error'
          });
        });
      }
    });
  });

  $('#file-input').on('change', function() {
    const file = this.files[0];
    const fileName = file ? file.name : 'No file';
    $('#file-name').text(fileName);
    let preview = '';
    if (file) {
      if (file.type.startsWith('image/')) {
        const url = URL.createObjectURL(file);
        preview = `<img src='${url}' style='max-width:80px;max-height:80px;border-radius:8px;margin-left:4px;'>`;
      } else if (file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file);
        preview = `<video controls style='max-width:120px;max-height:80px;margin-left:4px;'><source src='${url}' type='${file.type}'></video>`;
      } else if (file.type.startsWith('audio/')) {
        const url = URL.createObjectURL(file);
        preview = `<audio controls style='max-width:120px;margin-left:4px;'><source src='${url}' type='${file.type}'></audio>`;
      } else if (file.type.includes('pdf')) {
        preview = `<i class='bi bi-file-earmark-pdf' style='font-size:2em;margin-left:4px;color:#d32f2f;'></i>`;
      } else if (file.type.includes('zip') || file.type.includes('rar') || file.type.includes('7z')) {
        preview = `<i class='bi bi-file-earmark-zip' style='font-size:2em;margin-left:4px;color:#f0ad4e;'></i>`;
      } else {
        preview = `<i class='bi bi-file-earmark' style='font-size:2em;margin-left:4px;'></i>`;
      }
      // Add cancel button
      preview += ` <button type='button' id='cancel-file-btn' class='btn btn-sm btn-outline-danger ms-2' title='Cancel'><i class='bi bi-x'></i></button>`;
    }
    $('#file-preview').html(preview);
  });

  // Cancel file selection
  $(document).on('click', '#cancel-file-btn', function() {
    // Replace file input with a fresh clone to ensure change event always fires
    const $oldInput = $('#file-input');
    const $newInput = $oldInput.clone().val('');
    $oldInput.replaceWith($newInput);
    $newInput.on('change', function() {
      const file = this.files[0];
      const fileName = file ? file.name : 'No file';
      $('#file-name').text(fileName);
      let preview = '';
      if (file) {
        if (file.type.startsWith('image/')) {
          const url = URL.createObjectURL(file);
          preview = `<img src='${url}' style='max-width:40px;max-height:40px;border-radius:6px;margin-left:4px;'>`;
        } else if (file.type.startsWith('video/')) {
          preview = `<i class='bi bi-film' style='font-size:1.3em;margin-left:4px;'></i>`;
        } else if (file.type.includes('pdf')) {
          preview = `<i class='bi bi-file-earmark-pdf' style='font-size:1.3em;margin-left:4px;color:#d32f2f;'></i>`;
        } else if (file.type.includes('zip') || file.type.includes('rar') || file.type.includes('7z')) {
          preview = `<i class='bi bi-file-earmark-zip' style='font-size:1.3em;margin-left:4px;color:#f0ad4e;'></i>`;
        } else if (file.type.startsWith('audio/')) {
          preview = `<i class='bi bi-music-note-beamed' style='font-size:1.3em;margin-left:4px;color:#007bff;'></i>`;
        } else {
          preview = `<i class='bi bi-file-earmark' style='font-size:1.3em;margin-left:4px;'></i>`;
        }
        preview += ` <button type='button' id='cancel-file-btn' class='btn btn-sm btn-outline-danger ms-2' title='Cancel'><i class='bi bi-x'></i></button>`;
      }
      $('#file-preview').html(preview);
    });
    $('#file-name').text('No file');
    $('#file-preview').html('');
    // Remove file from draft if using per-chat drafts
    if (currentRecipients && chatDrafts) {
      chatDrafts[currentRecipients] = chatDrafts[currentRecipients] || {text: '', file: null};
      chatDrafts[currentRecipients].file = null;
    }
  });

  $('#message-input').on('input', function() {
    // Save text draft for current chat
    if (currentRecipients) {
      chatDrafts[currentRecipients] = chatDrafts[currentRecipients] || {text: '', file: null};
      chatDrafts[currentRecipients].text = $(this).val();
    }
  });
});

// Enhance Enter key behavior: if file is selected, pressing Enter sends the file (and message if present)
$('#message-input').off('keydown').on('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#message-form').submit();
  }
});

// Request notification permission on page load
if (window.Notification && Notification.permission !== 'granted') {
  Notification.requestPermission();
}

function showBrowserNotification(msg) {
  if (window.Notification && Notification.permission === 'granted') {
    let body = msg.content ? msg.content : (msg.file ? 'Sent a file' : '');
    let notification = new Notification('New message from ' + msg.sender, {
      body: body,
      icon: '/static/icons/favicon.ico' // Optional: set your favicon or chat icon
    });
    notification.onclick = function() {
      window.focus();
      this.close();
    };
  }
}

// --- Reply and React Handlers ---
let replyToMsgId = null;

// Reply button click
$(document).on('click', '.reply-msg-btn', function() {
  const msgId = $(this).data('msg-id');
  const msgDiv = $(this).closest('.message');
  const msgSender = msgDiv.find('.sender').text();
  const msgContent = msgDiv.data('content') || msgDiv.find('.msg-content').text();
  replyToMsgId = msgId;
  
  // Determine which form to use based on current chat type
  const isGroupChat = currentRecipients && currentRecipients.startsWith('group-');
  const targetForm = isGroupChat ? '#group-message-form' : '#message-form';
  
  // Show reply preview above the appropriate input
  if ($('#reply-preview-bar').length === 0) {
    $(targetForm).prepend(`<div id='reply-preview-bar' class='alert alert-secondary py-1 px-2 mb-2 d-flex align-items-center justify-content-between'>
      <span><b>Replying to ${msgSender}:</b> ${msgContent}</span>
      <button type='button' class='btn btn-sm btn-outline-danger ms-2' id='cancel-reply-btn'><i class='bi bi-x'></i></button>
    </div>`);
  } else {
    $('#reply-preview-bar span').html(`<b>Replying to ${msgSender}:</b> ${msgContent}`);
  }
});
// Cancel reply
$(document).on('click', '#cancel-reply-btn', function() {
  replyToMsgId = null;
  $('#reply-preview-bar').remove();
});

// React button click (show emoji picker)
$(document).on('click', '.react-msg-btn', function(e) {
  e.stopPropagation();
  const msgId = $(this).data('msg-id');
  // Simple emoji picker (customize as needed)
  const emojis = ['👍','😂','❤️','😮','😢','🙏'];
  let picker = `<div class='emoji-picker border rounded bg-white p-2' style='position:absolute;z-index:10;'>`;
  emojis.forEach(emoji => {
    picker += `<span class='emoji-option' data-msg-id='${msgId}' data-emoji='${emoji}' style='font-size:1.5em;cursor:pointer;margin:0 4px;'>${emoji}</span>`;
  });
  picker += `</div>`;
  // Remove any existing picker
  $('.emoji-picker').remove();
  $(this).parent().append(picker);
});
// Click emoji to react
$(document).on('click', '.emoji-option', function(e) {
  e.stopPropagation();
  const msgId = $(this).data('msg-id');
  const emoji = $(this).data('emoji');
  socket.emit('react_message', {msg_id: msgId, emoji: emoji});
  $('.emoji-picker').remove();
});
// Remove reaction on click (if already reacted)
$(document).on('click', '.reaction.reacted', function(e) {
  e.stopPropagation();
  const msgId = $(this).data('msg-id');
  const emoji = $(this).data('emoji');
  socket.emit('remove_reaction', {msg_id: msgId, emoji: emoji});
});
// Hide emoji picker on outside click
$(document).on('click', function(e) {
  if (!$(e.target).closest('.emoji-picker, .react-msg-btn').length) {
    $('.emoji-picker').remove();
  }
});
// --- END Reply and React Handlers ---

// Update reactions in real time
socket.on('update_reactions', function(data) {
  const msgId = data.msg_id;
  const reactions = data.reactions;
  const msgDiv = $(`.message[data-msg-id='${msgId}']`);
  let reactionsHtml = '';
  if (reactions && Object.keys(reactions).length > 0) {
    reactionsHtml = `<div class='reactions-bar mt-1'>`;
    for (const [emoji, users] of Object.entries(reactions)) {
      let reacted = users.includes(USERNAME) ? 'reacted' : '';
      reactionsHtml += `<span class='reaction ${reacted}' data-msg-id='${msgId}' data-emoji='${emoji}' title='${users.join(', ')}'>${emoji} <span class='reaction-count'>${users.length}</span></span> `;
    }
    reactionsHtml += `</div>`;
  }
  msgDiv.find('.reactions-bar').remove();
  if (reactionsHtml) msgDiv.append(reactionsHtml);
});

// --- Audio Recording ---
let mediaRecorder = null;
let audioChunks = [];
let audioBlob = null;

$(document).on('click', '#audio-record-btn', function() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    $('#audio-record-status').text('Processing...').show();
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = function(e) {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = function() {
      audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(audioBlob);
      $('#audio-preview').attr('src', url).show();
      $('#audio-record-status').text('Audio ready!').show();
      // Show cancel button
      if ($('#cancel-audio-btn').length === 0) {
        $('#audio-record-area').append(`<button type='button' id='cancel-audio-btn' class='btn btn-sm btn-outline-danger ms-2' title='Cancel'><i class='bi bi-x'></i></button>`);
      }
    };
    mediaRecorder.start();
    $('#audio-record-status').text('Recording...').show();
    $('#audio-preview').hide();
    audioBlob = null;
    $('#cancel-audio-btn').remove();
  }).catch(function(err) {
    showPopup({
      title: 'Microphone Access Denied',
      message: 'Microphone access denied or not available.',
      icon: 'error'
    });
  });
});
// Cancel audio
$(document).on('click', '#cancel-audio-btn', function() {
  audioBlob = null;
  $('#audio-preview').hide().attr('src', '');
  $('#audio-record-status').hide();
  $(this).remove();
});

// --- WhatsApp-like Group Chat Frontend Logic ---
$(document).ready(function() {
  // Load group list
  function loadGroups() {
    // Cache-busting param to avoid stale lists after create/delete
    $.get(`/api/groups?_r=${Date.now()}`, function(groups) {
      let $list = $('#group-list');
      $list.empty();
      if (!groups.length) {
        $list.append('<li class="list-group-item text-muted">No groups yet</li>');
      } else {
        groups.forEach(function(g) {
          let iconUrl = (g.icon || `/api/group_photo/${g.id}`) + `?_=${Date.now()}`;
          let icon = `<img src='${iconUrl}' class='group-avatar' style='width:28px;height:28px;border-radius:50%;margin-right:8px;' onerror="this.onerror=null;this.style.display='none';this.parentElement.insertAdjacentHTML('afterbegin',\`<i class=\'bi bi-people-fill\' style=\'font-size:1.3em;margin-right:8px;\'></i>\`);">`;
          // Add a badge for new messages
          let badge = `<span class='badge bg-danger ms-auto group-badge' style='display:none;' data-count='0'></span>`;
          $list.append(`<li class="list-group-item group-item d-flex align-items-center justify-content-between" data-group-id="${g.id}" data-search-text="${g.name.toLowerCase()}">${icon}<span>${g.name}</span>${badge}</li>`);
        });
      }
      syncMobileSidebar(); // <-- Ensure mobile sidebar is updated after groups load
    });
  }
  
  // Function to refresh the groups list - can be called from other scripts
  function refreshGroupsList() {
    loadGroups();
  }
  
  // Make the function globally available
  window.refreshGroupsList = refreshGroupsList;
  
  loadGroups();

  // Open create group modal
  $(document).on('click', '#open-create-group-modal', function() {
    // Load user list for member selection with checkboxes
    $.get('/users_status', function(users) {
      let $list = $('#group-members-list');
      $list.empty();
      users.forEach(function(u) {
        if (u.username === USERNAME) return;
        $list.append(`
          <div class="list-group-item d-flex align-items-center justify-content-between">
            <div>
              <input type="checkbox" class="form-check-input group-member-checkbox" value="${u.username}" id="member-${u.username}">
              <label for="member-${u.username}" class="form-check-label ms-2">${u.username}</label>
            </div>
            <div>
              <input type="checkbox" class="form-check-input group-admin-checkbox" value="${u.username}" id="admin-${u.username}">
              <label for="admin-${u.username}" class="form-check-label ms-1 text-primary">Admin</label>
            </div>
          </div>
        `);
      });
    });
    $('#createGroupModal').modal('show');
  });

  // Ensure no duplicate bindings before attaching
  $(document).off('click', '#create-group-btn');
  $(document).off('submit', '#create-group-form');
  // Handle group creation
  $(document).on('click', '#create-group-btn', function(){ $('#create-group-form').trigger('submit'); });
  $('#create-group-form').submit(function(e) {
    e.preventDefault();
    let name = $('#group-name').val().trim();
    let description = $('#group-description').val().trim();
    // Handle optional/missing icon field safely
    let icon = (($('#group-icon').val && $('#group-icon').val()) || '').trim();
    let members = [];
    let admins = [USERNAME]; // Always include self as admin
    $('.group-member-checkbox:checked').each(function() {
      members.push($(this).val());
    });
    members.push(USERNAME); // Always include self as member
    members = [...new Set(members)];
    $('.group-admin-checkbox:checked').each(function() {
      admins.push($(this).val());
    });
    admins = [...new Set(admins)];
    if (!name) {
      showPopup({
        title: 'Group Name Required',
        message: 'Please enter a group name.',
        icon: 'warning'
      });
      return;
    }
    if (members.length < 2) {
      showPopup({
        title: 'Select Members',
        message: 'Select at least one member for the group.',
        icon: 'warning'
      });
      return;
    }
    $.ajax({
      url: '/api/groups/', // <-- Add trailing slash to avoid 301 redirect
      type: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({ name: name, description: description, members: members, admins: admins, icon: icon || null }),
      success: function(resp, textStatus, xhr) {
        const isJson = (xhr.getResponseHeader('Content-Type') || '').includes('application/json');
        const ok = (resp && resp.success === true) || (!isJson && xhr.status >= 200 && xhr.status < 300);
        if (ok) {
          // Success path
          $('#createGroupModal').modal('hide');
          $('#group-name').val('');
          $('#group-description').val('');
          if ($('#group-icon').length) $('#group-icon').val('');
          $('.group-member-checkbox').prop('checked', false);
          $('.group-admin-checkbox').prop('checked', false);
          loadGroups();
          return;
        }
        // Not ok: show error
        showPopup({
          title: 'Create Group Failed',
          message: (resp && resp.error) ? resp.error : 'Group creation failed',
          icon: 'error'
        });
      },
      error: function(xhr) {
        // Some servers send HTML on success with 200; guard against that too
        if (xhr.status >= 200 && xhr.status < 300) {
          try { $('#createGroupModal').modal('hide'); } catch(e) {}
          try { loadGroups(); } catch(e) {}
          return;
        }
        showPopup({
          title: 'Create Group Failed',
          message: (xhr.responseJSON && xhr.responseJSON.error) || 'Group creation failed',
          icon: 'error'
        });
        console.error('Group creation error:', xhr);
      }
    });
  });

  // Click group to open chat
  $(document).on('click', '.group-item', function() {
    // Remove 'active' from all user and group items
    $('#user-list .user-item, #group-list .group-item').removeClass('active animated-select');
    $(this).addClass('active animated-select');
    let groupId = $(this).data('group-id');
    currentRecipients = 'group-' + groupId;
    currentGroupId = groupId;
    // Clear any active reply state when switching chats
    replyToMsgId = null;
    $('#reply-preview-bar').remove();
    socket.emit('join', {room: 'group-' + groupId}); // Join group room for real-time
    $('#group-chat-title').text('Group: ' + $(this).find('span').text());
    // Load group messages (reuse loadHistory but pass groupId)
    loadGroupHistory(groupId);
    updateGroupInfoBtn();
    // Clear group badge when group is opened
    clearGroupBadge(groupId);
    // Persist selection for refresh (server-backed group)
    saveLastChat({ type: 'group', groupId: String(groupId) });
      // Mark all messages as read for this group
      $.post('/mark_read', { group_id: groupId }, function(resp) {
        if (resp.success) {
          clearGroupBadge(groupId);
          fetchAndUpdateUnreadCounts();
        }
      });
  });

  // Mobile: open user chat
  $('#mobile-user-list').on('click', '.user-item', function() {
    // Hide mobile sidebar and show chat area immediately
    $('#mobileSidebarPanel').hide();
    $('.chat-col').addClass('active');
    // Remove active state from nav buttons
    $('#tabChats, #tabGroups').removeClass('active');
    let user = $(this).data('user');
    if (user === USERNAME) return;
    currentRecipients = user;
    groupUsers = [];
    // Clear any active reply state when switching chats
    replyToMsgId = null;
    $('#reply-preview-bar').remove();
    $('#chat-title').text('Chat with ' + user);
    loadHistory(user);
    clearBadge(user);
    restoreDraftFor(user);
      // Mark all messages as read for this chat (mobile)
      $.post('/mark_read', { user: user }, function(resp) {
        if (resp.success) {
          clearBadge(user);
          fetchAndUpdateUnreadCounts();
        }
      });
  });

  // Mobile: open group chat
  $('#mobile-group-list').on('click', '.group-item', function() {
    // Hide mobile sidebar and show chat area immediately
    $('#mobileSidebarPanel').hide();
    $('.chat-col').addClass('active');
    // Remove active state from nav buttons
    $('#tabChats, #tabGroups').removeClass('active');
    let groupId = $(this).data('group-id');
    currentRecipients = 'group-' + groupId;
    currentGroupId = groupId;
    // Clear any active reply state when switching chats
    replyToMsgId = null;
    $('#reply-preview-bar').remove();
    socket.emit('join', {room: 'group-' + groupId});
    $('#group-chat-title').text('Group: ' + $(this).find('span').text());
    loadGroupHistory(groupId);
    updateGroupInfoBtn();
    clearGroupBadge(groupId);
    // Persist selection for refresh
    saveLastChat({ type: 'group', groupId: String(groupId) });
      // Mark all messages as read for this group (mobile)
      $.post('/mark_read', { group_id: groupId }, function(resp) {
        if (resp.success) {
          clearGroupBadge(groupId);
          fetchAndUpdateUnreadCounts();
        }
      });
  });

  // Load group chat history
  function loadGroupHistory(groupId) {
    $('#group-chat-body').html('<div class="text-center text-muted">Loading group chat...</div>');
    $.get('/history', { group_id: groupId }, function(data) {
      $('#group-chat-body').empty();
      data.forEach(function(msg, idx) {
        renderMessage(msg, idx === data.length - 1);
      });
    });
  }

  // Delegated event handler for mobile new group button
  $(document).on('click', '#mobile-new-group-btn', function(e) {
    e.preventDefault();
    console.log('[DEBUG] #mobile-new-group-btn clicked');
    // Check if modal exists
    if ($('#createGroupModal').length === 0) {
      console.error('[ERROR] #createGroupModal not found in DOM');
      showPopup({
        title: 'Error',
        message: 'Group modal not found.',
        icon: 'error'
      });
      return;
    }
    // Check if Bootstrap modal method is available
    if (typeof $('#createGroupModal').modal !== 'function') {
      console.error('[ERROR] Bootstrap modal() function not available');
      showPopup({
        title: 'Error',
        message: 'Bootstrap modal JS not loaded.',
        icon: 'error'
      });
      return;
    }
    // Try to trigger the desktop button (in case logic is there)
    const $desktopBtn = $('#open-create-group-modal');
    if ($desktopBtn.length) {
      $desktopBtn.trigger('click');
      // Also show modal directly as fallback (in case event is missed)
      setTimeout(function() {
        if (!$('#createGroupModal').hasClass('show')) {
          try {
            $('#createGroupModal').modal('show');
          } catch (err) {
            console.error('[ERROR] Failed to show modal:', err);
            showPopup({
              title: 'Error',
              message: 'Failed to open group modal. See console for details.',
              icon: 'error'
            });
          }
        }
      }, 100);
    } else {
      // Fallback: show modal directly
      try {
        $('#createGroupModal').modal('show');
      } catch (err) {
        console.error('[ERROR] Failed to show modal:', err);
        showPopup({
          title: 'Error',
          message: 'Failed to open group modal. See console for details.',
          icon: 'error'
        });
      }
    }
  });
});
// --- END WhatsApp-like Group Chat Frontend Logic ---
// --- Group Info Modal Logic ---
let currentGroupId = null;

// Open group info modal
$('#group-info-btn').on('click', function() {
  if (!currentGroupId) return;
  $.get(`/api/groups/${currentGroupId}`, function(info) {
    // Icon, name, created, description
    if (info.icon) {
      $('#group-info-icon').attr('src', info.icon).show();
      $('#group-info-default-icon').hide();
    } else {
      $('#group-info-icon').hide();
      $('#group-info-default-icon').show();
    }
    $('#group-info-name').text(info.name);
    $('#group-info-created').text('Created by ' + info.created_by + ' on ' + info.created_at);
    $('#group-info-description').text(info.description || '');
    // Members view for all
    let membersHtml = '<ul class="list-group">';
    info.members.forEach(m => {
      let adminBadge = m.is_admin ? " <span class='badge bg-primary ms-1'>Admin</span>" : '';
      membersHtml += `<li class='list-group-item d-flex align-items-center justify-content-between'>${m.username}${adminBadge}</li>`;
    });
    membersHtml += '</ul>';
    $('#group-info-members-view').html(membersHtml);
    // If admin, show settings form
    if (info.is_admin) {
      $('#group-settings-form').show();
      // Populate editable fields
      $('#edit-group-name').val(info.name);
      $('#edit-group-description').val(info.description || '');
      // Load all users for member/admin management
      $.get('/users_status', function(users) {
        let $list = $('#group-settings-members-list');
        $list.empty();
        users.forEach(function(u) {
          let isMember = info.members.some(m => m.username === u.username);
          let isAdmin = info.members.some(m => m.username === u.username && m.is_admin);
          let disabled = u.username === info.created_by ? 'disabled' : '';
          $list.append(`
            <div class="list-group-item d-flex align-items-center justify-content-between">
              <div>
                <input type="checkbox" class="form-check-input group-settings-member-checkbox" value="${u.username}" id="settings-member-${u.username}" ${isMember ? 'checked' : ''} ${disabled}>
                <label for="settings-member-${u.username}" class="form-check-label ms-2">${u.username}</label>
              </div>
              <div>
                <input type="checkbox" class="form-check-input group-settings-admin-checkbox" value="${u.username}" id="settings-admin-${u.username}" ${isAdmin ? 'checked' : ''} ${disabled}>
                <label for="settings-admin-${u.username}" class="form-check-label ms-1 text-primary">Admin</label>
              </div>
            </div>
          `);
        });
      });
      // Admin-only toggle
      $('#admin-only-toggle').prop('checked', info.admin_only);
    } else {
      $('#group-settings-form').hide();
    }
    $('#groupInfoModal').modal('show');
  });
});

// Save group settings
// Group settings form submission is now handled by group_management.js
// Delete group
$('#delete-group-btn').on('click', function() {
  showPopup({
    title: 'Delete Group',
    message: 'Are you sure you want to delete this group? This cannot be undone.',
    icon: 'warning',
    okText: 'Delete',
    cancelText: 'Cancel',
    showCancel: true,
    onOk: function() {
      $.post(`/groups/${currentGroupId}/delete`, function(resp) {
        if (resp.success) {
          const deletedId = currentGroupId;
          // Remove from DOM immediately
          $(`#group-list .group-item[data-group-id='${deletedId}']`).remove();
          $(`#mobile-group-list .group-item[data-group-id='${deletedId}']`).remove();
          // Reset UI state
          $('#groupInfoModal').modal('hide');
          if ($('#group-list .group-item').length === 0) {
            $('#group-list').html('<li class="list-group-item text-muted">No groups yet</li>');
          }
          // Reset only group header/body since we are in the Groups section
          $('#group-chat-title').text('Select a group to start messaging');
          $('#group-chat-body').html('<div class="text-center text-muted">Select a group to start messaging</div>');
          currentRecipients = null;
          updateGroupInfoBtn();
          // Reload from server (cache-busted) to stay in sync
          loadGroups();
          // Notify others
          socket.emit('group_deleted', { group_id: deletedId });
        } else {
          showPopup({
            title: 'Delete Failed',
            message: resp.error || 'Failed to delete group',
            icon: 'error'
          });
        }
      });
    }
  });
});

// Listen for group_deleted event and reload group list in real time
socket.on('group_deleted', function(data) {
  loadGroups();
  if (currentGroupId == data.group_id) {
    $('#groupInfoModal').modal('hide');
    $('#chat-title').text('Select a user or group to start chatting.');
    $('#chat-body').html('<div class="text-center text-muted">Select a user or group to start chatting.</div>');
    currentRecipients = null;
    updateGroupInfoBtn();
  }
});

// Mute group
$(document).on('click', '#mute-group-btn', function() {
  if (!currentGroupId) return;
  $.post(`/groups/${currentGroupId}/mute`, function(resp) {
    if (resp.success) {
      $('#mute-group-btn').hide();
      $('#unmute-group-btn').show();
    } else {
      showPopup({
        title: 'Mute Failed',
        message: resp.error || 'Failed to mute group',
        icon: 'error'
      });
    }
  });
});
// Unmute group
$(document).on('click', '#unmute-group-btn', function() {
  if (!currentGroupId) return;
  $.post(`/groups/${currentGroupId}/unmute`, function(resp) {
    if (resp.success) {
      $('#unmute-group-btn').hide();
      $('#mute-group-btn').show();
    } else {
      showPopup({
        title: 'Unmute Failed',
        message: resp.error || 'Failed to unmute group',
        icon: 'error'
      });
    }
  });
});
// Leave group
$(document).on('click', '#leave-group-btn', function() {
  showPopup({
    title: 'Leave Group',
    message: 'Are you sure you want to leave this group?',
    icon: 'warning',
    okText: 'Leave',
    cancelText: 'Cancel',
    showCancel: true,
    onOk: function() {
      $.post(`/groups/${currentGroupId}/leave`, function(resp) {
        if (resp.success) {
          $('#groupInfoModal').modal('hide');
          loadGroups();
          $('#chat-title').text('Select a user or group to start chatting.');
          $('#chat-body').html('<div class=\"text-center text-muted\">Select a user or group to start chatting.</div>');
          currentRecipients = null;
          updateGroupInfoBtn();
        } else {
          showPopup({
            title: 'Leave Failed',
            message: resp.error || 'Failed to leave group',
            icon: 'error'
          });
        }
      });
    }
  });
});

function updateGroupInfoBtn() {
  if (currentRecipients && typeof currentRecipients === 'string' && currentRecipients.startsWith('group-')) {
    $('#group-info-btn').removeClass('d-none').show();
  } else {
    $('#group-info-btn').addClass('d-none').hide();
  }
}

// Always update group info button on chat switch
$(document).on('click', '.group-item', function() { updateGroupInfoBtn(); });
$('#user-list').on('click', '.user-item', function() { updateGroupInfoBtn(); });

// Handle error when non-admin tries to send message in admin-only group
socket.on('group_admin_only_error', function(data) {
  // Show error as a toast or alert (replace with a better UI as needed)
  let errMsg = data && data.error ? data.error : 'Only admins can send messages in this group.';
  // Remove any previous error
  $('#admin-only-error').remove();
  // Show error above the message input
  $("#message-form").prepend(`<div id='admin-only-error' class='alert alert-warning py-1 mb-2'>${errMsg}</div>`);
  setTimeout(function() { $('#admin-only-error').fadeOut(500, function() { $(this).remove(); }); }, 2500);
});

function syncMobileSidebar() {
  // Copy user list
  $('#mobile-user-list').html($('#user-list').html());
  // Copy group list
  $('#mobile-group-list').html($('#group-list').html());
  // Ensure .user-item class is present
  $('#mobile-user-list li').addClass('user-item');
  $('#mobile-group-list li').addClass('user-item');
  // Attach mobile new group button handler
  $('#mobile-new-group-btn').off('click').on('click', function() {
    $('#open-create-group-modal').trigger('click');
  });
}

// --- In-app notification for mobile ---
function isMobileView() {
  return window.innerWidth <= 768;
}

function showInAppNotification(msg) {
  // Remove any existing notification
  $('#in-app-notification').remove();
  let sender = msg.sender;
  let isGroup = msg.recipients && msg.recipients.startsWith('group-');
  let chatId = isGroup ? msg.recipients : sender;
  let chatName = isGroup ? ($(`#group-list .group-item[data-group-id='${msg.recipients.split('-')[1]}'] span`).text() || 'Group') : sender;
  let content = msg.content ? msg.content : (msg.file ? 'Sent a file' : 'New message');
  let html = `
    <div id="in-app-notification" style="position:fixed;left:0;right:0;bottom:70px;z-index:9999;display:flex;justify-content:center;">
      <div class="toast show align-items-center text-bg-primary border-0" role="alert" style="min-width:220px;max-width:90vw;box-shadow:0 2px 8px rgba(0,0,0,0.2);cursor:pointer;" data-chat-id="${chatId}" data-is-group="${isGroup}">
        <div class="d-flex">
          <div class="toast-body">
            <b>${chatName}:</b> ${content}
          </div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
      </div>
    </div>
  `;
  $('body').append(html);
  // Auto-hide after 5 seconds
  setTimeout(function() { $('#in-app-notification').fadeOut(300, function() { $(this).remove(); }); }, 5000);
}

// Click handler for in-app notification
$(document).on('click', '#in-app-notification', function(e) {
  let $toast = $(this).find('.toast');
  let chatId = $toast.data('chat-id');
  let isGroup = $toast.data('is-group');
  $('#in-app-notification').remove();
  if (isGroup) {
    // Open group chat
    let groupId = chatId.split('-')[1];
    currentRecipients = 'group-' + groupId;
    currentGroupId = groupId;
    socket.emit('join', {room: 'group-' + groupId});
    $('#chat-title').text('Group: ' + ($(`#group-list .group-item[data-group-id='${groupId}'] span`).text() || 'Group'));
    if (isMobileView()) {
      $('#mobileSidebarPanel').hide();
      $('.chat-col').addClass('active');
      $('#tabChats, #tabGroups').removeClass('active');
    }
    // Load group messages
    if (typeof loadGroupHistory === 'function') {
      loadGroupHistory(groupId);
    }
    clearGroupBadge(groupId);
    updateGroupInfoBtn();
  } else {
    // Open user chat
    if (chatId === USERNAME) return;
    currentRecipients = chatId;
    groupUsers = [];
    $('#chat-title').text('Chat with ' + chatId);
    if (isMobileView()) {
      $('#mobileSidebarPanel').hide();
      $('.chat-col').addClass('active');
      $('#tabChats, #tabGroups').removeClass('active');
    }
    loadHistory(chatId);
    clearBadge(chatId);
    restoreDraftFor(chatId);
  }
});

// Close button for in-app notification
$(document).on('click', '#in-app-notification .btn-close', function(e) {
  e.stopPropagation();
  $('#in-app-notification').remove();
});

// --- Chat tab badge for mobile bottom nav ---
function updateChatTabBadge() {
  // Check if any user or group badge is visible and has count > 0
  let hasUnread = false;
  $('#user-list .badge, #group-list .group-badge').each(function() {
    if ($(this).is(':visible') && parseInt($(this).attr('data-count')) > 0) {
      hasUnread = true;
      return false;
    }
  });
  if (hasUnread) {
    $('#chat-tab-badge').show();
  } else {
    $('#chat-tab-badge').hide();
  }
}

function updateBadge(badgeId, count) {
    const badge = $('#' + badgeId);
    if (count > 0) {
        badge.text(count).show();
    } else {
        badge.hide();
    }
}

// Example usage for chats and groups:
// updateBadge('chats-badge', unreadChatsCount);
// updateBadge('groups-badge', unreadGroupsCount);
// updateBadge('pending-requests-badge', pendingRequestsCount);
// updateBadge('reset-requests-badge', resetRequestsCount);

// Replace all direct badge.text(count) or badge.text('0') calls with updateBadge.
// For demonstration, you can call updateBadge with 0 to hide, or with a number to show.

// Note: Duplicate showBadge function removed - using the one above at line 177

// Additional clearBadge function (keeping this one as it's used)
function clearBadgeAlt(user) {
  let badge = $(`#badge-${user}`);
  badge.attr('data-count', 0);
  badge.text('');
  badge.hide();
  syncMobileSidebar(); // Ensure mobile sidebar badge is updated
  updateChatTabBadge(); // Update chat tab badge
}
// Show badge for group
function showGroupBadge(groupId, sender) {
  let $item = $(`#group-list .group-item[data-group-id='${groupId}']`);
  let badge = $item.find('.group-badge');
  // If item missing, try to refresh list and retry shortly
  if (!$item.length) {
    if (typeof window.refreshGroupsList === 'function') {
      try { window.refreshGroupsList(); } catch (e) {}
    }
    setTimeout(() => showGroupBadge(groupId, sender), 300);
    return;
  }
  // Create badge if missing
  if (!badge.length) {
    badge = $(`<span class='badge bg-danger ms-auto group-badge' style='display:none;' data-count='0'></span>`);
    $item.append(badge);
  }
  let count = parseInt(badge.attr('data-count')) || 0;
  count++;
  badge.attr('data-count', count);
  // Show "New" if single unread, otherwise show only the count
  if (count === 1) {
    badge.text('New');
  } else {
    badge.text(String(count));
  }
  badge.show();
  syncMobileSidebar(); // Ensure mobile sidebar badge is updated
  updateChatTabBadge(); // Update chat tab badge
}
// Clear badge for group
function clearGroupBadge(groupId) {
  let badge = $(`#group-list .group-item[data-group-id='${groupId}'] .group-badge`);
  badge.attr('data-count', 0);
  badge.text('');
  badge.hide();
  groupUnreadSenders[groupId] = [];
  syncMobileSidebar(); // Ensure mobile sidebar badge is updated
  updateChatTabBadge(); // Update chat tab badge
}

// --- Theme Switcher Dropdown Logic ---
function applyTheme(theme) {
  document.body.classList.remove('dark-theme', 'blue-theme', 'green-theme');
  if (theme === 'dark') {
    document.body.classList.add('dark-theme');
  } else if (theme === 'blue') {
    document.body.classList.add('blue-theme');
  } else if (theme === 'green') {
    document.body.classList.add('green-theme');
  }
  // Save to localStorage
  localStorage.setItem('theme', theme);
}

$(function() {
  // Theme toggle handler
  function setTheme(isDark) {
    if (isDark) {
      $('body').addClass('dark-theme');
      $('#theme-toggle-btn i').removeClass('bi-moon').addClass('bi-sun');
    } else {
      $('body').removeClass('dark-theme');
      $('#theme-toggle-btn i').removeClass('bi-sun').addClass('bi-moon');
    }
  }
  // On load, check localStorage
  const savedTheme = localStorage.getItem('theme');
  setTheme(savedTheme === 'dark');
  // Toggle on button click
  $('#theme-toggle-btn').on('click', function() {
    const isDark = !$('body').hasClass('dark-theme');
    setTheme(isDark ? 'dark' : 'light');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });

  // Theme switcher dropdown
  const themeSwitcher = document.getElementById('theme-switcher');
  if (themeSwitcher) {
    // On change
    themeSwitcher.addEventListener('change', function() {
      applyTheme(this.value);
    });
    // On load, set theme from localStorage
    let savedTheme = localStorage.getItem('theme') || 'light';
    applyTheme(savedTheme);
    themeSwitcher.value = savedTheme;
  }
});
// --- END Theme Switcher Dropdown Logic ---

// --- Info Button Logic ---
function updateInfoBtns() {
  if (currentRecipients && typeof currentRecipients === 'string') {
    if (currentRecipients.startsWith('group-')) {
      $('#group-info-btn').removeClass('d-none').show();
      $('#chat-info-btn').addClass('d-none').hide();
    } else {
      $('#chat-info-btn').removeClass('d-none').show();
      $('#group-info-btn').addClass('d-none').hide();
    }
  } else {
    $('#chat-info-btn').addClass('d-none').hide();
    $('#group-info-btn').addClass('d-none').hide();
  }
}
// Call updateInfoBtns on chat/group switch
$(document).on('click', '.group-item, .user-item', updateInfoBtns);

// --- Chat Info Modal Logic ---
$('#chat-info-btn').on('click', function() {
  if (!currentRecipients || currentRecipients.startsWith('group-')) return;
  // Populate chat info (show username, maybe last seen, etc.)
  let user = currentRecipients;
  let html = `<div><b>User:</b> ${user}</div>`;
  // Optionally, add more info (last seen, etc.)
  $('#chat-info-content').html(html);
  $('#chatInfoModal').modal('show');
});
// Delete Chat (clear history)
$('#delete-chat-btn').on('click', function() {
  if (!currentRecipients || currentRecipients.startsWith('group-')) return;
  showPopup({
    title: 'Delete Chat',
    message: 'Are you sure you want to delete this chat? This will clear the chat history for you.',
    icon: 'warning',
    okText: 'Delete',
    cancelText: 'Cancel',
    showCancel: true,
    onOk: function() {
      // Call backend to delete chat history (implement endpoint if needed)
      $.post('/delete_message', { user: currentRecipients }, function(resp) {
        // On success, clear chat body
        $('#chat-body').html('<div class="text-center text-muted">Chat deleted.</div>');
        $('#chatInfoModal').modal('hide');
      });
    }
  });
});
// Clear conversation handler for chat info modal
$(document).on('click', '#clear-chat-btn', function() {
  if (!currentRecipients || currentRecipients.startsWith('group-')) return;
  showPopup({
    title: 'Clear Conversation',
    message: 'Are you sure you want to clear this conversation? This will remove all messages for you, but not for the other user.',
    icon: 'warning',
    okText: 'Clear',
    cancelText: 'Cancel',
    showCancel: true,
    onOk: function() {
      // Show immediate feedback
      const btn = $('#clear-chat-btn');
      const originalHtml = btn.html();
      btn.data('original-html', originalHtml);
      btn.html('<i class="bi bi-hourglass-split"></i> Clearing...').prop('disabled', true);
      
      $.post('/clear_chat', { user: currentRecipients }, function(resp) {
        if (resp.success) {
          // Instant feedback for the user who cleared it
          $('#chat-body').html('<div class="text-center text-muted">Chat cleared.</div>');
          // Restore button BEFORE closing modal to avoid it staying stuck on next open
          btn.html(originalHtml).prop('disabled', false);
          $('#chatInfoModal').modal('hide');
        } else {
          // Restore button on error
          btn.html(originalHtml).prop('disabled', false);
          showPopup({
            title: 'Clear Failed',
            message: resp.error || 'Failed to clear chat',
            icon: 'error'
          });
        }
      }).fail(function() {
        // Restore button on network error
        btn.html(originalHtml).prop('disabled', false);
        showPopup({
          title: 'Clear Failed',
          message: 'Network error occurred',
          icon: 'error'
        });
      }).always(function(){
        // Safety: ensure the button is never left disabled indefinitely
        const orig = btn.data('original-html') || originalHtml || 'Clear Conversation';
        btn.html(orig).prop('disabled', false);
      });
    }
  });
});
// --- Group Info Modal Logic (already present, just ensure works) ---
$('#group-info-btn').on('click', function() {
  if (!currentRecipients || !currentRecipients.startsWith('group-')) return;
  // Existing logic should show group info modal
  // Optionally, reload group info here
  $('#groupInfoModal').modal('show');
});
// Clear group conversation handler for group info modal
$(document).on('click', '#clear-group-chat-btn', function() {
  if (!currentGroupId) return;
  showPopup({
    title: 'Clear Group Conversation',
    message: 'Are you sure you want to clear this group conversation? This will remove all group messages for you, but not for other members.',
    icon: 'warning',
    okText: 'Clear',
    cancelText: 'Cancel',
    showCancel: true,
    onOk: function() {
      // Show immediate feedback
      const btn = $('#clear-group-chat-btn');
      const originalHtml = btn.html();
      btn.data('original-html', originalHtml);
      btn.html('<i class="bi bi-hourglass-split"></i> Clearing...').prop('disabled', true);
      
      $.post('/clear_group_chat', { group_id: currentGroupId }, function(resp) {
        if (resp.success) {
          // Instant feedback for the user who cleared it
          $('#group-chat-body').html('<div class="text-center text-muted">Group chat cleared.</div>');
          // Restore button BEFORE closing modal to avoid it staying stuck on next open
          btn.html(originalHtml).prop('disabled', false);
          $('#groupInfoModal').modal('hide');
        } else {
          // Restore button on error
          btn.html(originalHtml).prop('disabled', false);
          showPopup({
            title: 'Clear Failed',
            message: resp.error || 'Failed to clear group chat',
            icon: 'error'
          });
        }
      }).fail(function() {
        // Restore button on network error
        btn.html(originalHtml).prop('disabled', false);
        showPopup({
          title: 'Clear Failed',
          message: 'Network error occurred',
          icon: 'error'
        });
      }).always(function(){
        // Safety: ensure the button is never left disabled indefinitely
        const orig = btn.data('original-html') || originalHtml || 'Clear Conversation';
        btn.html(orig).prop('disabled', false);
      });
    }
  });
});
// --- Suggestions for further improvements ---
// 1. Add search/filter in chat/group lists
// 2. Show last seen/online status in chat info
// 3. Add group icon upload/change
// 4. Add mute notifications for chats/groups
// 5. Add member roles and leave group option in group info

// --- Section Persistence Logic ---
function showSection(sectionName) {
    // Hide all sections
    $('.section-content').removeClass('active');
    // Show the requested section
    $('#' + sectionName + '-section').addClass('active');
    // Save to localStorage
    localStorage.setItem('lastSection', sectionName);
}

function fetchAndUpdateRequestBadges() {
    // Pending user requests
    $.get('/pending-requests', function(html) {
        // Count table rows with class 'table-warning' (pending requests)
        var pending = $(html).find('tr.table-warning').length;
        updateBadge('pending-requests-badge', pending);
    });
    // Pending reset requests
    $.get('/reset-requests', function(html) {
        // Count table rows with class 'table-warning' and data-reset attribute (pending resets)
        var resets = $(html).find('tr.table-warning[data-reset]').length;
        updateBadge('reset-requests-badge', resets);
    });
}

// 🔥 ENHANCED: Real-time sidebar update function
function fetchAndUpdateUnreadCounts() {
    $.get('/unread_counts', function(data) {
        console.log('📊 Fetched unread counts:', data);
        
        if (data.chats !== undefined) {
            updateBadge('chats-badge', data.chats);
            console.log('📱 Updated chats badge:', data.chats);
        }
        if (data.groups !== undefined) {
            updateBadge('groups-badge', data.groups);
            console.log('📱 Updated groups badge:', data.groups);
        }
        
    // Update individual user badges from server data
    if (data.individual_badges) {
      // First, clear all existing badges
      $('#user-list .user-item').each(function() {
        const user = $(this).data('user');
        if (user) {
          clearBadge(user);
        }
      });
      
      // Then show badges only for users with unread messages
      Object.keys(data.individual_badges).forEach(user => {
        const count = data.individual_badges[user];
        if (count > 0) {
          // Set the badge count directly instead of incrementing
          let badge = $(`#badge-${user}`);
          if (!badge.length) {
            const $item = $(`#user-list .user-item[data-user='${user}']`);
            badge = $(`<span class="badge bg-danger ms-auto" id="badge-${user}" style="display:none;" data-count="0"></span>`);
            $item.append(badge);
          }
          badge.attr('data-count', count);
          if (count === 1) {
            badge.text('New');
          } else {
            badge.text(String(count));
          }
          badge.show();
        }
      });
    }
    
    // Update group badges from server data
    if (data.group_badges) {
      // First, clear all existing group badges
      $('#group-list .group-item').each(function() {
        const groupId = $(this).data('group-id');
        if (groupId) {
          clearGroupBadge(groupId);
        }
      });
      
      // Then show badges only for groups with unread messages
      Object.keys(data.group_badges).forEach(groupId => {
        const count = data.group_badges[groupId];
        if (count > 0) {
          // Set the group badge count directly instead of incrementing
          let $item = $(`#group-list .group-item[data-group-id='${groupId}']`);
          let badge = $item.find('.group-badge');
          if (!badge.length) {
            badge = $(`<span class='badge bg-danger ms-auto group-badge' style='display:none;' data-count='0'></span>`);
            $item.append(badge);
          }
          badge.attr('data-count', count);
          if (count === 1) {
            badge.text('New');
          } else {
            badge.text(String(count));
          }
          badge.show();
        }
      });
    }
        
        // Sync mobile sidebar to ensure consistency
        if (typeof syncMobileSidebar === 'function') {
            syncMobileSidebar();
        }
    }).fail(function() {
        console.warn('⚠️ Failed to fetch unread counts');
    });
    
    fetchAndUpdateRequestBadges();
}

$(document).ready(function() {
    // Helper to show only the correct section
    function showSection(sectionName) {
        $('.section-content').removeClass('active');
        $('#' + sectionName + '-section').addClass('active');
        $('.nav-link').removeClass('active');
        $('.nav-link[data-section="' + sectionName + '"]').addClass('active');
        localStorage.setItem('lastSection', sectionName);
    }

    // Sidebar nav click handlers
    // Disabled SPA-style handler: full navigation is handled in dashboard.html capturing listener
    $(document).off('click', '.nav-link[data-section="chats"]');
    // Disabled SPA-style handler: full navigation is handled in dashboard.html capturing listener
    $(document).off('click', '.nav-link[data-section="groups"]');

    // On page load, show the correct section
    var lastSection = localStorage.getItem('lastSection');
    if (window.location.pathname.endsWith('/groups')) {
        showSection('groups');
        loadGroups();
    } else if (lastSection && $('#' + lastSection + '-section').length) {
        showSection(lastSection);
        if (lastSection === 'groups') {
            loadGroups();
        } else {
            $.get('/users_status', updateUserListFromStatus);
        }
    } else {
        showSection('chats');
        $.get('/users_status', updateUserListFromStatus);
    }
    fetchAndUpdateUnreadCounts();
    setInterval(fetchAndUpdateUnreadCounts, 10000); // Poll every 10 seconds

    // Note: Real-time message handling moved to main receive_message handler above (line ~266)
});

// Sidebar logo click: navigate directly to dashboard (splash disabled)
$(document).on('click', '#sidebar-logo-link', function(e) {
    e.preventDefault();
    window.location.href = '/dashboard';
});

// --- Enhanced Universal Interactive Popup ---
function showPopup({
  title = 'Notification',
  message = '',
  okText = 'OK',
  cancelText = 'Cancel',
  onOk = null,
  onCancel = null,
  showCancel = false,
  icon = null, // e.g., 'success', 'error', 'info', 'warning'
  autoClose = 0, // Time in ms to auto-close (0 = disabled)
  extraContent = null, // HTML content for additional elements (forms, etc.)
  theme = 'default' // 'default', 'dark', 'light'
} = {}) {
  // Reset any existing progress bar animation
  $('#popupProgressBar').stop().css('width', '0%');
  
  // Set the title
  $('#universalPopupTitle').text(title);
  
  // Handle icon
  let iconClass = '';
  let iconColorClass = '';
  
  if (icon) {
    if (icon === 'success') {
      iconClass = 'bi bi-check-circle-fill';
      iconColorClass = 'popup-icon-success';
    } else if (icon === 'error') {
      iconClass = 'bi bi-x-circle-fill';
      iconColorClass = 'popup-icon-error';
    } else if (icon === 'warning') {
      iconClass = 'bi bi-exclamation-triangle-fill';
      iconColorClass = 'popup-icon-warning';
    } else if (icon === 'info') {
      iconClass = 'bi bi-info-circle-fill';
      iconColorClass = 'popup-icon-info';
    }
    
    // Insert icon with animation
    $('#popupIconContainer').html(`<i class='${iconClass} ${iconColorClass}'></i>`).show();
  } else {
    $('#popupIconContainer').empty().hide();
  }
  
  // Set message in its own container
  $('#popupMessageContainer').html(message);
  
  // Handle extra content if provided
  if (extraContent) {
    $('#popupExtraContent').html(extraContent).removeClass('d-none');
  } else {
    $('#popupExtraContent').empty().addClass('d-none');
  }
  
  // Set button text
  $('#universalPopupOkBtn').text(okText);
  
  // Handle cancel button
  if (showCancel) {
    $('#universalPopupCancelBtn').text(cancelText).removeClass('d-none');
  } else {
    $('#universalPopupCancelBtn').addClass('d-none');
  }
  
  // Apply theme if specified
  if (theme === 'dark') {
    $('#universalPopupModal .modal-content').addClass('bg-dark text-light');
    $('#universalPopupOkBtn').addClass('btn-outline-light').removeClass('btn-primary');
  } else if (theme === 'light') {
    $('#universalPopupModal .modal-content').addClass('bg-light').removeClass('bg-dark text-light');
    $('#universalPopupOkBtn').addClass('btn-primary').removeClass('btn-outline-light');
  } else {
    // Default theme
    $('#universalPopupModal .modal-content').removeClass('bg-dark text-light bg-light');
    $('#universalPopupOkBtn').addClass('btn-primary').removeClass('btn-outline-light');
  }
  
  // Remove previous handlers
  $('#universalPopupOkBtn').off('click');
  $('#universalPopupCancelBtn').off('click');
  
  // Set up OK button handler
  if (onOk) {
    $('#universalPopupOkBtn').on('click', function() {
      setTimeout(onOk, 200); // Delay to allow modal to close
    });
  }
  
  // Set up Cancel button handler
  if (showCancel && onCancel) {
    $('#universalPopupCancelBtn').on('click', function() {
      setTimeout(onCancel, 200);
    });
  }
  
  // Show the modal
  let modal = new bootstrap.Modal(document.getElementById('universalPopupModal'));
  modal.show();
  
  // Handle auto-close with progress bar animation
  if (autoClose > 0) {
    $('#popupProgressBar').animate({
      width: '100%'
    }, autoClose, 'linear', function() {
      modal.hide();
      if (onOk) {
        setTimeout(onOk, 200);
      }
    });
  }
  
  // Return the modal instance for advanced control
  return modal;
}

// Helper functions for common popup scenarios
function showSuccessPopup(message, options = {}) {
  return showPopup({
    title: options.title || 'Success',
    message: message,
    icon: 'success',
    okText: options.okText || 'OK',
    onOk: options.onOk || null,
    autoClose: options.autoClose || 0,
    theme: options.theme || 'default'
  });
}

function showErrorPopup(message, options = {}) {
  return showPopup({
    title: options.title || 'Error',
    message: message,
    icon: 'error',
    okText: options.okText || 'OK',
    onOk: options.onOk || null,
    theme: options.theme || 'default'
  });
}

function showWarningPopup(message, options = {}) {
  return showPopup({
    title: options.title || 'Warning',
    message: message,
    icon: 'warning',
    showCancel: options.showCancel || false,
    okText: options.okText || 'OK',
    cancelText: options.cancelText || 'Cancel',
    onOk: options.onOk || null,
    onCancel: options.onCancel || null,
    theme: options.theme || 'default'
  });
}

function showInfoPopup(message, options = {}) {
  return showPopup({
    title: options.title || 'Information',
    message: message,
    icon: 'info',
    okText: options.okText || 'OK',
    onOk: options.onOk || null,
    autoClose: options.autoClose || 0,
    theme: options.theme || 'default'
  });
}

function showConfirmPopup(message, onConfirm, options = {}) {
  return showPopup({
    title: options.title || 'Confirm',
    message: message,
    icon: options.icon || 'warning',
    showCancel: true,
    okText: options.okText || 'Yes',
    cancelText: options.cancelText || 'No',
    onOk: onConfirm,
    onCancel: options.onCancel || null,
    theme: options.theme || 'default'
  });
}

function showFormPopup(formHtml, onSubmit, options = {}) {
  // Create a form with submit handler
  const formContent = `
    <form id="popupForm" onsubmit="return false;">
      ${formHtml}
    </form>
  `;
  
  const modal = showPopup({
    title: options.title || 'Form',
    message: options.message || '',
    icon: options.icon || null,
    showCancel: true,
    okText: options.okText || 'Submit',
    cancelText: options.cancelText || 'Cancel',
    extraContent: formContent,
    onOk: function() {
      // Get form data
      const formData = {};
      $('#popupForm').serializeArray().forEach(item => {
        formData[item.name] = item.value;
      });
      
      // Call the submit handler with form data
      if (onSubmit) onSubmit(formData);
    },
    onCancel: options.onCancel || null,
    theme: options.theme || 'default'
  });
  
  // Focus the first input field
  setTimeout(() => {
    $('#popupForm input:first').focus();
  }, 400);
  
  return modal;
}

function loadFilesTable() {
    $.get('/files_data', function(resp) {
        const tbody = $('#files-table-body');
        tbody.empty();
        if (!resp.files || resp.files.length === 0) {
            tbody.append('<tr><td colspan="7" class="text-center">No files found.</td></tr>');
            return;
        }
        resp.files.forEach(function(file) {
            // Determine if sent or received
            let type = (file.uploader === USERNAME) ? 'Sent' : 'Received';
            let toFrom = file.uploader;
            let viewBtn = `<button class="btn btn-sm btn-info view-file-btn" data-url="${file.download_url}" title="View"><i class="bi bi-eye"></i></button>`;
            // Show delete for sender, admin, and receivers (backend enforces final auth)
            let canDelete = true;
            let deleteBtn = canDelete ? `<button class="btn btn-sm btn-danger delete-file-btn" data-file-id="${file.file_id}" title="Delete"><i class="bi bi-trash"></i></button>` : '';
            // Force download via ?download=1
            let downloadUrl = `${file.download_url}?download=1`;
            let row = `<tr>
                <td>${file.original_name}</td>
                <td>${type}</td>
                <td>${toFrom}</td>
                <td>${file.timestamp}</td>
                <td>
                    <a href="${downloadUrl}" target="_blank" rel="noopener" class="btn btn-sm btn-primary">Download</a>
                    ${viewBtn}
                    ${deleteBtn}
                </td>
            </tr>`;
            tbody.append(row);
        });
    });
}

// Disabled SPA-style handler: full navigation is handled in dashboard.html capturing listener
$(document).off('click', '.nav-link[data-section="files"]');

// --- Group Message Form Handler ---
$('#group-message-form').on('submit', function(e) {
  e.preventDefault();
  let content = $('#group-message-input').val();
  let file = $('#group-file-input')[0].files[0];
  if (!content && !file) return;
  let data = {
    recipients: currentRecipients, // should be 'group-<id>'
    content: content
  };
  if (replyToMsgId) data.reply_to = replyToMsgId;
  if (file) {
    let formData = new FormData();
    formData.append('file', file);
    $('#group-message-form button[type="submit"]').prop('disabled', true);
    $.ajax({
      url: '/upload',
      type: 'POST',
      data: formData,
      processData: false,
      contentType: false,
      success: function(resp) {
        if (resp.file_id) {
          data.file_id = resp.file_id;
          socket.emit('send_message', data);
        } else {
          showPopup({
            title: 'Upload Failed',
            message: 'File upload failed.',
            icon: 'error'
          });
        }
      },
      error: function(xhr) {
        showPopup({
          title: 'Upload Failed',
          message: 'File upload failed: ' + (xhr.responseJSON?.error || 'Unknown error'),
          icon: 'error'
        });
      },
      complete: function() {
        $('#group-file-input').val('');
        $('#group-file-preview').html('');
        $('#group-message-input').val('');
        replyToMsgId = null;
        $('#reply-preview-bar').remove();
        $('#group-message-form button[type="submit"]').prop('disabled', false);
      }
    });
  } else {
    socket.emit('send_message', data);
    $('#group-message-input').val('');
    $('#group-file-input').val('');
    $('#group-file-preview').html('');
    replyToMsgId = null;
    $('#reply-preview-bar').remove();
  }
});

// View file handler
$(document).on('click', '.view-file-btn', function() {
    const url = $(this).data('url');
    window.open(url, '_blank');
});

// Delete file handler
$(document).on('click', '.delete-file-btn', function() {
    const fileId = $(this).data('file-id');
    if (!fileId) return;
    showPopup({
        title: 'Delete File',
        message: 'Are you sure you want to delete this file? This will remove the file and all messages referencing it.',
        icon: 'warning',
        okText: 'Delete',
        cancelText: 'Cancel',
        showCancel: true,
        onOk: function() {
            // 🔥 Show immediate feedback
            const btn = $(`.delete-file-btn[data-file-id='${fileId}']`);
            const originalHtml = btn.html();
            btn.html('<i class="bi bi-hourglass-split"></i>').prop('disabled', true);
            
            $.post(`/delete_file/${fileId}`, function(resp) {
                if (resp.success) {
                    // Real-time event will handle the actual removal
                    console.log('File deletion initiated');
                } else {
                    // Restore button on error
                    btn.html(originalHtml).prop('disabled', false);
                    showPopup({
                        title: 'Delete Failed',
                        message: resp.error || 'Delete failed',
                        icon: 'error'
                    });
                }
            }).fail(function() {
                // Restore button on network error
                btn.html(originalHtml).prop('disabled', false);
                showPopup({
                    title: 'Delete Failed',
                    message: 'Network error occurred',
                    icon: 'error'
                });
            });
        }
    });
});

$('#group-file-input').on('change', function() {
    const file = this.files[0];
    let preview = '';
    if (file) {
        if (file.type.startsWith('image/')) {
            const url = URL.createObjectURL(file);
            preview = `<img src='${url}' style='max-width:80px;max-height:80px;border-radius:8px;margin-left:4px;'>`;
        } else if (file.type.startsWith('video/')) {
            const url = URL.createObjectURL(file);
            preview = `<video controls style='max-width:120px;max-height:80px;margin-left:4px;'><source src='${url}' type='${file.type}'></video>`;
        } else if (file.type.startsWith('audio/')) {
            const url = URL.createObjectURL(file);
            preview = `<audio controls style='max-width:120px;margin-left:4px;'><source src='${url}' type='${file.type}'></audio>`;
        } else if (file.type.includes('pdf')) {
            preview = `<i class='bi bi-file-earmark-pdf' style='font-size:2em;margin-left:4px;color:#d32f2f;'></i>`;
        } else if (file.type.includes('zip') || file.type.includes('rar') || file.type.includes('7z')) {
            preview = `<i class='bi bi-file-earmark-zip' style='font-size:2em;margin-left:4px;color:#f0ad4e;'></i>`;
        } else {
            preview = `<i class='bi bi-file-earmark' style='font-size:2em;margin-left:4px;'></i>`;
        }
        // Add cancel button
        preview += `<button type='button' class='btn btn-sm btn-danger ms-2' id='cancel-group-file-btn'><i class='bi bi-x'></i></button>`;
    }
    $('#group-file-preview').html(preview);
});

// Cancel group file preview
$(document).on('click', '#cancel-group-file-btn', function() {
    $('#group-file-input').val('');
    $('#group-file-preview').html('');
});
