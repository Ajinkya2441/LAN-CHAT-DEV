/**
 * Group Management JavaScript
 * Handles enhanced group management features including:
 * - Admin management
 * - Member management
 * - Group settings
 * - Role management
 * - Notification preferences
 * - Pinned messages
 */

// Global variables
let currentGroupMembers = [];
let currentGroupAdmins = [];
let currentGroupCreator = null;
let isCurrentUserGroupAdmin = false;
let currentGroupPinnedMessages = [];

// Initialize group management UI
function initGroupManagement() {
    // Hide admin tab for non-admins
    $('#admin-tab').parent().hide();
    
    // Add member button click handler
    $('#add-member-btn').on('click', openAddMemberModal);
    
    // Confirm add member button click handler
    $('#confirm-add-member-btn').on('click', addMemberToGroup);
    
    // Group settings form submission handler
    $('#group-settings-form').on('submit', function(e) {
        e.preventDefault();
        updateGroupSettings();
    });
    
    // Group photo upload handler
    $('#group-photo-input').on('change', function() {
        const file = this.files[0];
        if (!file || !currentGroupId) return;
        const fd = new FormData();
        fd.append('group_photo', file);
        $.ajax({
            url: `/api/groups/${currentGroupId}/upload_photo`,
            type: 'POST',
            data: fd,
            processData: false,
            contentType: false,
            success: function(res) {
                if (res && res.success) {
                    // Bust caches
                    const url = res.photo_url + '?_=' + Date.now();
                    // Update previews in both header and settings
                    $('#group-info-icon').attr('src', url).show();
                    $('#group-info-default-icon').hide();
                    $('#group-settings-photo-preview').attr('src', url).show();
                    $('#group-settings-photo-placeholder').hide();
                    // Also refresh the group list item avatar if present
                    const $glistImg = $(`#group-list .group-item[data-group-id='${currentGroupId}'] img.group-avatar`);
                    if ($glistImg.length) $glistImg.attr('src', url);
                    showPopup({ title: 'Group Photo Updated', message: 'New photo applied.', icon: 'success' });
                } else {
                    showPopup({ title: 'Error', message: (res && res.error) || 'Failed to upload photo.', icon: 'error' });
                }
            },
            error: function() {
                showPopup({ title: 'Error', message: 'Upload failed.', icon: 'error' });
            }
        });
    });
    
    // Group photo upload button click handler
    $('#upload-group-photo-btn').on('click', function() {
        $('#group-photo-input').click();
    });

    // Remove group photo
    $('#remove-group-photo-btn').on('click', function() {
        if (!currentGroupId) return;
        $.post(`/api/groups/${currentGroupId}/remove_photo`, {}, function(res) {
            if (res && res.success) {
                const url = `/api/group_photo/${currentGroupId}?_=${Date.now()}`;
                // Show defaults via API (which serves default when no custom)
                $('#group-info-icon').attr('src', url).show();
                $('#group-info-default-icon').hide();
                $('#group-settings-photo-preview').attr('src', url).show();
                $('#group-settings-photo-placeholder').hide();
                // Refresh group list avatar
                const $glistImg = $(`#group-list .group-item[data-group-id='${currentGroupId}'] img.group-avatar`);
                if ($glistImg.length) $glistImg.attr('src', url);
                showPopup({ title: 'Group Photo Removed', message: 'Reverted to default.', icon: 'success' });
            } else {
                showPopup({ title: 'Error', message: (res && res.error) || 'Failed to remove photo.', icon: 'error' });
            }
        }).fail(function() {
            showPopup({ title: 'Error', message: 'Remove failed.', icon: 'error' });
        });
    });
    
    // Save notification preferences button click handler
    $('#save-notification-preference-btn').on('click', saveNotificationPreference);
    
    // Member remove button click handler (delegated)
    $(document).on('click', '.remove-member-btn', function() {
        const username = $(this).data('username');
        removeMemberFromGroup(username);
    });
    
    // Member promote/demote button click handler (delegated)
    $(document).on('click', '.toggle-admin-btn', function() {
        const username = $(this).data('username');
        const isAdmin = $(this).data('is-admin') === true;
        toggleAdminStatus(username, !isAdmin);
    });
    
    // Admin toggle (delegated)
    $(document).on('change', '.toggle-admin-status', function() {
        const username = $(this).data('username');
        const isAdmin = $(this).is(':checked');
        toggleAdminStatus(username, isAdmin);
    });
    
    // PIN functionality removed
    
    // PIN functionality removed
    
    // Group search button handler
    $('#group-search-btn').on('click', searchGroupMessages);
    
    // Group search input enter key handler
    $('#group-search-input').on('keypress', function(e) {
        if (e.which === 13) {
            searchGroupMessages();
        }
    });
    
    // Toggle user filter for search
    $('#search-from-user').on('change', function() {
        if ($(this).is(':checked')) {
            $('#search-user-select').show();
        } else {
            $('#search-user-select').hide();
        }
    });
    
    // Toggle date range filter for search
    $('#search-date-range').on('change', function() {
        if ($(this).is(':checked')) {
            $('.date-range-inputs').show();
        } else {
            $('.date-range-inputs').hide();
        }
    });
    
    // File type filter buttons
    $('.btn-group [data-file-type]').on('click', function() {
        $('.btn-group [data-file-type]').removeClass('active');
        $(this).addClass('active');
        loadGroupFiles(currentGroupId, $(this).data('file-type'));
    });
}

// Load group info and populate UI
function loadGroupInfo(groupId) {
    if (!groupId) return;
    
    // Store the current group ID to prevent race conditions
    const requestedGroupId = groupId;
    
    $.ajax({
        url: `/api/groups/${requestedGroupId}`,
        type: 'GET',
        cache: false, // Prevent caching to always get fresh data
        success: function(info) {
            // Only update if this is still the requested group
            currentGroupId = requestedGroupId;
            currentGroupMembers = info.members.map(m => m.username);
            currentGroupAdmins = info.members.filter(m => m.is_admin).map(m => m.username);
            currentGroupCreator = info.created_by;
            isCurrentUserGroupAdmin = info.is_admin;
            
            // Get current user info
            const currentUser = info.members.find(m => m.username === USERNAME);
            
            // Update UI based on admin status
            updateGroupManagementUI(info);
            
            // PIN functionality removed
            
            // Show the modal
            $('#groupInfoModal').modal('show');
        },
        error: function() {
            showPopup({
                title: 'Error',
                message: 'Failed to load group information. Please try again.',
                icon: 'error'
            });
        }
    });
}

// PIN functionality removed

// Update group management UI based on group info
function updateGroupManagementUI(info) {
    // Basic info
    if (info.icon) {
        const url = info.icon + '?_=' + Date.now();
        $('#group-info-icon').attr('src', url).show();
        $('#group-info-default-icon').hide();
        $('#group-settings-photo-preview').attr('src', url).show();
        $('#group-settings-photo-placeholder').hide();
        // Update group list avatar if present
        const $glistImg = $(`#group-list .group-item[data-group-id='${info.id}'] img.group-avatar`);
        if ($glistImg.length) $glistImg.attr('src', url);
    } else {
        $('#group-info-icon').hide();
        $('#group-info-default-icon').show();
        $('#group-settings-photo-preview').hide();
        $('#group-settings-photo-placeholder').show();
    }
    
    // Update group info header
    $('#group-info-name').text(info.name);
    $('#group-info-created').text('Created by ' + info.created_by + ' on ' + info.created_at);
    
    // Handle description - ensure it displays properly even if empty
    const description = info.description !== null && info.description !== undefined ? info.description : '';
    $('#group-info-description').text(description || 'No description available');
    
    // Members tab
    renderMembersList(info.members);
    
    // Settings tab - ensure form values match the current group data
    $('#edit-group-name').val(info.name);
    $('#edit-group-description').val(description);
    $('#admin-only-toggle').prop('checked', info.admin_only);
    
    // Get current user's notification preference
    const currentUser = info.members.find(m => m.username === USERNAME);
    if (currentUser && currentUser.notification_preference) {
        $(`#notify-${currentUser.notification_preference}`).prop('checked', true);
    } else {
        $('#notify-all').prop('checked', true);
    }
    
    // Admin tab
    if (info.is_admin) {
        $('#admin-tab').parent().show();
        renderAdminManagementList(info.members);
    } else {
        $('#admin-tab').parent().hide();
    }
    

    
    // Populate user select for search
    const $userSelect = $('#search-user-select');
    $userSelect.empty();
    info.members.forEach(member => {
        $userSelect.append(`<option value="${member.username}">${member.username}</option>`);
    });
    
    // Load files for the files tab
    loadGroupFiles(info.id, 'all');
    
    // Load activity log
    loadGroupActivity(info.id);
    
    // Show/hide buttons based on permissions
    if (info.is_admin) {
        $('#add-member-btn').show();
        $('#settings-tab').parent().show();
        $('#delete-group-btn').show();
    } else {
        $('#add-member-btn').hide();
        $('#settings-tab').parent().hide();
        $('#delete-group-btn').hide();
    }
    
    // Always show leave button except for creator
    if (USERNAME === info.created_by) {
        $('#leave-group-btn').hide();
    } else {
        $('#leave-group-btn').show();
    }
}



// Toggle admin status for a user
function toggleAdminStatus(username, isAdmin) {
    if (!username || !currentGroupId) {
        return;
    }
    
    // Show loading state
    const $checkboxes = $(`.toggle-admin-status[data-username="${username}"]`);
    $checkboxes.prop('disabled', true);
    
    // Call API to set admin status
    $.ajax({
        url: `/api/groups/${currentGroupId}/set_admin`,
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ 
            username: username,
            is_admin: isAdmin
        }),
        success: function(response) {
            if (response.success) {
                // Show success message
                showPopup({
                    title: 'Admin Status Updated',
                    message: `${username} is ${isAdmin ? 'now' : 'no longer'} an admin.`,
                    icon: 'success'
                });
                
                // Update admin status in our local list
                if (isAdmin && !currentGroupAdmins.includes(username)) {
                    currentGroupAdmins.push(username);
                } else if (!isAdmin && currentGroupAdmins.includes(username)) {
                    currentGroupAdmins = currentGroupAdmins.filter(a => a !== username);
                }
                
                // Update all checkboxes for this user
                $checkboxes.prop('checked', isAdmin);
            } else {
                showPopup({
                    title: 'Error',
                    message: response.error || 'Failed to update admin status.',
                    icon: 'error'
                });
                
                // Reset checkboxes to previous state
                $checkboxes.prop('checked', !isAdmin);
            }
        },
        error: function() {
            showPopup({
                title: 'Error',
                message: 'Failed to update admin status. Please try again.',
                icon: 'error'
            });
            
            // Refresh to ensure UI is in sync with server state
            loadGroupInfo(currentGroupId);
        },
        complete: function() {
            // Re-enable checkboxes
            $checkboxes.prop('disabled', false);
        }
    });
}

// Save notification preference
function saveNotificationPreference() {
    if (!currentGroupId) {
        return;
    }
    
    const preference = $('input[name="notification-preference"]:checked').val() || 'all';
    
    // Show loading state
    const $btn = $('#save-notification-preference-btn');
    const originalText = $btn.text();
    $btn.html('<i class="bi bi-hourglass-split"></i> Saving...').prop('disabled', true);
    
    // Call API to update preference
    $.ajax({
        url: `/api/groups/${currentGroupId}/notification_preference`,
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ preference: preference }),
        success: function(response) {
            if (response.success) {
                // Show success message
                showPopup({
                    title: 'Preferences Saved',
                    message: 'Your notification preferences have been updated.',
                    icon: 'success'
                });
            } else {
                showPopup({
                    title: 'Error',
                    message: response.error || 'Failed to save notification preferences.',
                    icon: 'error'
                });
            }
        },
        error: function() {
            showPopup({
                title: 'Error',
                message: 'Failed to save notification preferences. Please try again.',
                icon: 'error'
            });
        },
        complete: function() {
            // Reset button
            $btn.html(originalText).prop('disabled', false);
        }
    });
}

// PIN functionality removed

// Render members list with appropriate actions
function renderMembersList(members) {
    let html = '<ul class="list-group">';
    
    members.forEach(member => {
        const isCreator = member.username === currentGroupCreator;
        const isAdmin = member.is_admin;
        const canRemove = isCurrentUserGroupAdmin && !isCreator && member.username !== USERNAME;
        const canPromote = isCurrentUserGroupAdmin && !isCreator && !isAdmin && member.username !== USERNAME;
        
        html += `<li class="list-group-item d-flex align-items-center justify-content-between">
            <div>
                <img src="${getProfilePhotoUrl(member.username)}" alt="${member.username}" 
                    class="rounded-circle me-2" style="width: 30px; height: 30px; object-fit: cover;">
                <span>${member.username}</span>
                ${isCreator ? '<span class="badge bg-primary ms-2">Creator</span>' : ''}
                ${isAdmin && !isCreator ? '<span class="badge bg-info ms-2">Admin</span>' : ''}
            </div>
            <div>
                ${canPromote ? `
                <button class="btn btn-sm btn-outline-primary promote-admin-btn me-1" data-username="${member.username}">
                    <i class="bi bi-shield-plus"></i> Promote to Admin
                </button>` : ''}
                ${canRemove ? `
                <button class="btn btn-sm btn-outline-danger remove-member-btn" data-username="${member.username}">
                    <i class="bi bi-person-x"></i> Remove
                </button>` : ''}
            </div>
        </li>`;
    });
    
    html += '</ul>';
    $('#group-info-members-view').html(html);
    
    // Add event handler for promote admin buttons
    $('.promote-admin-btn').on('click', function() {
        const username = $(this).data('username');
        toggleAdminStatus(username, true);
    });
}

// Render admin management list - only show admins
function renderAdminManagementList(members) {
    // Filter to only show admins
    const adminMembers = members.filter(member => member.is_admin);
    
    if (adminMembers.length === 0) {
        $('#group-settings-members-list').html('<div class="alert alert-info">No administrators in this group yet.</div>');
        return;
    }
    
    let html = '<ul class="list-group">';
    
    adminMembers.forEach(member => {
        const isCreator = member.username === currentGroupCreator;
        
        html += `<li class="list-group-item d-flex align-items-center justify-content-between">
            <div>
                <img src="${getProfilePhotoUrl(member.username)}" alt="${member.username}" 
                    class="rounded-circle me-2" style="width: 30px; height: 30px; object-fit: cover;">
                <span>${member.username}</span>
                ${isCreator ? '<span class="badge bg-primary ms-2">Creator</span>' : '<span class="badge bg-info ms-2">Admin</span>'}
            </div>
            <div>
                ${!isCreator && member.username !== USERNAME ? `
                <button class="btn btn-sm btn-outline-danger remove-admin-btn" data-username="${member.username}">
                    <i class="bi bi-person-dash"></i> Remove Admin
                </button>` : (isCreator ? '<span class="text-muted">Permanent Admin</span>' : '')}
            </div>
        </li>`;
    });
    
    html += '</ul>';
    $('#group-settings-members-list').html(html);
    
    // Add event handler for remove admin buttons
    $('.remove-admin-btn').on('click', function() {
        const username = $(this).data('username');
        toggleAdminStatus(username, false);
    });
}

// Open add member modal
function openAddMemberModal() {
    // Get all users who are not already in the group
    $.get('/users_status', function(users) {
        const nonMembers = users.filter(user => 
            user.username !== USERNAME && 
            !currentGroupMembers.includes(user.username)
        );
        
        // Populate select dropdown
        const $select = $('#add-member-select');
        $select.empty();
        
        if (nonMembers.length === 0) {
            $select.append('<option value="">No available users to add</option>');
            $('#confirm-add-member-btn').prop('disabled', true);
        } else {
            nonMembers.forEach(user => {
                $select.append(`<option value="${user.username}">${user.username}</option>`);
            });
            $('#confirm-add-member-btn').prop('disabled', false);
        }
        
        // Reset admin checkbox
        $('#add-as-admin-checkbox').prop('checked', false);
        
        // Show modal
        $('#addGroupMemberModal').modal('show');
    });
}

// Add member to group
function addMemberToGroup() {
    const username = $('#add-member-select').val();
    const isAdmin = $('#add-as-admin-checkbox').is(':checked');
    
    if (!username || !currentGroupId) {
        return;
    }
    
    // Show loading state
    const $btn = $('#confirm-add-member-btn');
    const originalText = $btn.text();
    $btn.html('<i class="bi bi-hourglass-split"></i> Adding...').prop('disabled', true);
    
    // Call API to add member
    $.ajax({
        url: `/api/groups/${currentGroupId}/add_member`,
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ 
            username: username,
            is_admin: isAdmin
        }),
        success: function(response) {
            if (response.success) {
                // Close modal
                $('#addGroupMemberModal').modal('hide');
                
                // Refresh group info
                loadGroupInfo(currentGroupId);
                
                // Show success message
                showPopup({
                    title: 'Member Added',
                    message: `${username} has been added to the group${isAdmin ? ' as an admin' : ''}.`,
                    icon: 'success'
                });
            } else {
                showPopup({
                    title: 'Error',
                    message: response.error || 'Failed to add member to group.',
                    icon: 'error'
                });
            }
        },
        error: function() {
            showPopup({
                title: 'Error',
                message: 'Failed to add member to group. Please try again.',
                icon: 'error'
            });
        },
        complete: function() {
            // Reset button
            $btn.html(originalText).prop('disabled', false);
        }
    });
}

// Remove member from group
function removeMemberFromGroup(username) {
    if (!username || !currentGroupId) {
        return;
    }
    
    // Confirm removal
    showPopup({
        title: 'Remove Member',
        message: `Are you sure you want to remove ${username} from this group?`,
        icon: 'warning',
        okText: 'Remove',
        cancelText: 'Cancel',
        showCancel: true,
        onOk: function() {
            // Call API to remove member
            $.ajax({
                url: `/api/groups/${currentGroupId}/remove_member`,
                type: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({ username: username }),
                success: function(response) {
                    if (response.success) {
                        // Refresh group info
                        loadGroupInfo(currentGroupId);
                        
                        // Show success message
                        showPopup({
                            title: 'Member Removed',
                            message: `${username} has been removed from the group.`,
                            icon: 'success'
                        });
                    } else {
                        showPopup({
                            title: 'Error',
                            message: response.error || 'Failed to remove member from group.',
                            icon: 'error'
                        });
                    }
                },
                error: function() {
                    showPopup({
                        title: 'Error',
                        message: 'Failed to remove member from group. Please try again.',
                        icon: 'error'
                    });
                }
            });
        }
    });
}

// Toggle admin status for a member
function toggleAdminStatus(username, makeAdmin) {
    if (!username || !currentGroupId) {
        return;
    }
    
    // Call API to set admin status
    $.ajax({
        url: `/api/groups/${currentGroupId}/set_admin`,
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ 
            username: username,
            is_admin: makeAdmin
        }),
        success: function(response) {
            if (response.success) {
                // Refresh group info
                loadGroupInfo(currentGroupId);
                
                // Show success message
                showPopup({
                    title: 'Admin Status Updated',
                    message: `${username} is ${makeAdmin ? 'now' : 'no longer'} an admin.`,
                    icon: 'success'
                });
            } else {
                showPopup({
                    title: 'Error',
                    message: response.error || 'Failed to update admin status.',
                    icon: 'error'
                });
                
                // Refresh to ensure UI is in sync with server state
                loadGroupInfo(currentGroupId);
            }
        },
        error: function() {
            showPopup({
                title: 'Error',
                message: 'Failed to update admin status. Please try again.',
                icon: 'error'
            });
            
            // Refresh to ensure UI is in sync with server state
            loadGroupInfo(currentGroupId);
        }
    });
}



// Search group messages
function searchGroupMessages() {
    if (!currentGroupId) return;
    
    const query = $('#group-search-input').val().trim();
    if (!query && !$('#search-from-user').is(':checked') && !$('#search-date-range').is(':checked')) {
        showPopup({
            title: 'Search Error',
            message: 'Please enter a search term or select a filter.',
            icon: 'error'
        });
        return;
    }
    
    // Show loading state
    $('#search-results-list').html('<div class="text-center py-4"><div class="spinner-border text-primary" role="status"></div><p class="mt-2">Searching messages...</p></div>').show();
    $('#no-search-results').hide();
    
    // Build query parameters
    let params = { q: query };
    
    if ($('#search-from-user').is(':checked')) {
        params.from_user = $('#search-user-select').val();
    }
    
    if ($('#search-date-range').is(':checked')) {
        params.date_from = $('#search-date-from').val();
        params.date_to = $('#search-date-to').val();
    }
    
    // Call API to search messages
    $.ajax({
        url: `/api/groups/${currentGroupId}/search`,
        type: 'GET',
        data: params,
        success: function(results) {
            if (results.length === 0) {
                $('#search-results-list').hide();
                $('#no-search-results').html('<i class="bi bi-search fs-3 d-block mb-2"></i>No messages found matching your search').show();
                return;
            }
            
            // Render results
            let html = '<div class="list-group">';
            
            results.forEach(msg => {
                const date = new Date(msg.timestamp);
                const formattedDate = date.toLocaleString();
                
                html += `
                <div class="list-group-item search-result" data-msg-id="${msg.id}">
                    <div class="d-flex justify-content-between align-items-center mb-1">
                        <strong>${msg.sender}</strong>
                        <small class="text-muted">${formattedDate}</small>
                    </div>
                    <p class="mb-1">${msg.content || ''}</p>
                    ${msg.has_file ? '<span class="badge bg-info"><i class="bi bi-paperclip"></i> Has attachment</span>' : ''}
                    <div class="mt-2">
                        <button class="btn btn-sm btn-outline-primary jump-to-message-btn" data-msg-id="${msg.id}">
                            <i class="bi bi-arrow-right-circle"></i> Jump to Message
                        </button>
                    </div>
                </div>`;
            });
            
            html += '</div>';
            $('#search-results-list').html(html).show();
            $('#no-search-results').hide();
            
            // Add jump to message handler
            $('.jump-to-message-btn').on('click', function() {
                const messageId = $(this).data('msg-id');
                jumpToMessage(messageId);
            });
        },
        error: function() {
            $('#search-results-list').hide();
            $('#no-search-results').html('<i class="bi bi-exclamation-triangle fs-3 d-block mb-2"></i>Error searching messages. Please try again.').show();
        }
    });
}

// Jump to a specific message in the chat
function jumpToMessage(messageId) {
    // Close the group info modal
    $('#groupInfoModal').modal('hide');
    
    // Scroll to the message
    setTimeout(() => {
        const $message = $(`.message[data-msg-id="${messageId}"]`);
        if ($message.length) {
            // Scroll to the message
            $message[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Highlight the message temporarily
            $message.addClass('highlight-message');
            setTimeout(() => {
                $message.removeClass('highlight-message');
            }, 3000);
        } else {
            showPopup({
                title: 'Message Not Found',
                message: 'The message could not be found in the current view.',
                icon: 'error'
            });
        }
    }, 500);
}

// Load group files
function loadGroupFiles(groupId, fileType = 'all') {
    if (!groupId) return;
    
    // Show loading state
    $('#files-grid').html('<div class="text-center py-4"><div class="spinner-border text-primary" role="status"></div><p class="mt-2">Loading files...</p></div>');
    
    // Call API to get files
    $.ajax({
        url: `/api/groups/${groupId}/files`,
        type: 'GET',
        data: { type: fileType },
        success: function(files) {
            if (files.length === 0) {
                $('#files-grid').hide();
                $('#no-files').show();
                return;
            }
            
            // Render files
            let html = '';
            
            files.forEach(file => {
                let fileIcon = '<i class="bi bi-file-earmark fs-1"></i>';
                let filePreview = '';
                
                if (file.file_type === 'image') {
                    fileIcon = '';
                    filePreview = `<img src="${file.file_path}" class="card-img-top file-preview" alt="${file.file_name}">`;
                } else if (file.file_type === 'document') {
                    if (file.file_extension === '.pdf') {
                        fileIcon = '<i class="bi bi-file-earmark-pdf fs-1 text-danger"></i>';
                    } else if (['.doc', '.docx'].includes(file.file_extension)) {
                        fileIcon = '<i class="bi bi-file-earmark-word fs-1 text-primary"></i>';
                    } else if (['.xls', '.xlsx'].includes(file.file_extension)) {
                        fileIcon = '<i class="bi bi-file-earmark-excel fs-1 text-success"></i>';
                    } else if (['.ppt', '.pptx'].includes(file.file_extension)) {
                        fileIcon = '<i class="bi bi-file-earmark-ppt fs-1 text-warning"></i>';
                    } else {
                        fileIcon = '<i class="bi bi-file-earmark-text fs-1 text-info"></i>';
                    }
                }
                
                html += `
                <div class="col">
                    <div class="card h-100">
                        <div class="card-file-preview text-center p-3">
                            ${filePreview}
                            ${fileIcon}
                        </div>
                        <div class="card-body">
                            <h6 class="card-title text-truncate" title="${file.file_name}">${file.file_name}</h6>
                            <p class="card-text small text-muted">
                                Shared by ${file.sender}<br>
                                ${new Date(file.timestamp).toLocaleString()}
                            </p>
                        </div>
                        <div class="card-footer">
                            <a href="${file.file_path}" class="btn btn-sm btn-primary" download="${file.file_name}">
                                <i class="bi bi-download"></i> Download
                            </a>
                            <button class="btn btn-sm btn-outline-secondary jump-to-file-btn" data-msg-id="${file.id}">
                                <i class="bi bi-chat"></i> View in Chat
                            </button>
                        </div>
                    </div>
                </div>`;
            });
            
            $('#files-grid').html(html).show();
            $('#no-files').hide();
            
            // Add jump to file message handler
            $('.jump-to-file-btn').on('click', function() {
                const messageId = $(this).data('msg-id');
                jumpToMessage(messageId);
            });
        },
        error: function() {
            $('#files-grid').hide();
            $('#no-files').html('<i class="bi bi-exclamation-triangle fs-3 d-block mb-2"></i>Error loading files. Please try again.').show();
        }
    });
}

// Load group activity log
function loadGroupActivity(groupId) {
    if (!groupId) return;
    
    // Call API to get activity log
    $.ajax({
        url: `/api/groups/${groupId}/activity`,
        type: 'GET',
        success: function(activities) {
            if (activities.length === 0) {
                $('#activity-list').hide();
                $('#no-activity').show();
                return;
            }
            
            // Render activity log
            let html = '<div class="timeline">';
            
            activities.forEach(activity => {
                const date = new Date(activity.timestamp);
                const formattedDate = date.toLocaleString();
                
                let icon = '';
                let title = '';
                let description = '';
                
                switch (activity.action_type) {
                    case 'member_added':
                        icon = '<i class="bi bi-person-plus text-success"></i>';
                        title = 'Member Added';
                        description = `${activity.actor} added ${activity.target} to the group`;
                        if (activity.details && activity.details.is_admin) {
                            description += ' as an admin';
                        }
                        break;
                    case 'member_removed':
                        icon = '<i class="bi bi-person-x text-danger"></i>';
                        title = 'Member Removed';
                        description = `${activity.actor} removed ${activity.target} from the group`;
                        break;
                    case 'admin_status_changed':
                        icon = '<i class="bi bi-shield text-primary"></i>';
                        title = 'Admin Status Changed';
                        if (activity.details && activity.details.is_admin) {
                            description = `${activity.actor} made ${activity.target} an admin`;
                        } else {
                            description = `${activity.actor} removed admin status from ${activity.target}`;
                        }
                        break;
                    case 'role_changed':
                        icon = '<i class="bi bi-person-badge text-info"></i>';
                        title = 'Role Changed';
                        description = `${activity.actor} changed ${activity.target}'s role to ${activity.details ? activity.details.role : 'member'}`;
                        break;
                    case 'photo_updated':
                        icon = '<i class="bi bi-image text-info"></i>';
                        title = 'Group Photo Updated';
                        description = `${activity.actor} updated the group photo`;
                        break;
                    case 'photo_removed':
                        icon = '<i class="bi bi-image-fill text-warning"></i>';
                        title = 'Group Photo Removed';
                        description = `${activity.actor} removed the group photo`;
                        break;
                    case 'group_name_changed':
                        icon = '<i class="bi bi-pencil-square text-primary"></i>';
                        title = 'Group Name Changed';
                        if (activity.details) {
                            description = `${activity.actor} changed group name from "${activity.details.old_name}" to "${activity.details.new_name}"`;
                        } else {
                            description = `${activity.actor} changed the group name`;
                        }
                        break;
                    case 'description_added':
                        icon = '<i class="bi bi-file-text text-success"></i>';
                        title = 'Description Added';
                        if (activity.details && activity.details.description) {
                            description = `${activity.actor} added group description: "${activity.details.description}"`;
                        } else {
                            description = `${activity.actor} added a group description`;
                        }
                        break;
                    case 'description_changed':
                        icon = '<i class="bi bi-file-text text-info"></i>';
                        title = 'Description Changed';
                        if (activity.details) {
                            description = `${activity.actor} changed group description from "${activity.details.old_description}" to "${activity.details.new_description}"`;
                        } else {
                            description = `${activity.actor} changed the group description`;
                        }
                        break;
                    case 'description_removed':
                        icon = '<i class="bi bi-file-text text-warning"></i>';
                        title = 'Description Removed';
                        description = `${activity.actor} removed the group description`;
                        break;
                    case 'admin_only_changed':
                        icon = '<i class="bi bi-lock text-warning"></i>';
                        title = 'Message Permissions Changed';
                        if (activity.details && activity.details.admin_only) {
                            description = `${activity.actor} restricted messaging to admins only`;
                        } else {
                            description = `${activity.actor} allowed all members to send messages`;
                        }
                        break;
                    // PIN functionality removed
                    case 'message_search':
                        icon = '<i class="bi bi-search text-info"></i>';
                        title = 'Message Search';
                        description = `${activity.actor} searched for messages`;
                        if (activity.details && activity.details.query) {
                            description += ` containing "${activity.details.query}"`;
                        }
                        break;
                    default:
                        icon = '<i class="bi bi-activity text-primary"></i>';
                        title = 'Group Activity';
                        description = `${activity.actor} performed an action`;
                }
                
                html += `
                <div class="timeline-item">
                    <div class="timeline-icon">${icon}</div>
                    <div class="timeline-content">
                        <h6 class="mb-1">${title}</h6>
                        <p class="mb-1">${description}</p>
                        <small class="text-muted">${formattedDate}</small>
                    </div>
                </div>`;
            });
            
            html += '</div>';
            $('#activity-list').html(html).show();
            $('#no-activity').hide();
        },
        error: function() {
            $('#activity-list').hide();
            $('#no-activity').html('<i class="bi bi-exclamation-triangle fs-3 d-block mb-2"></i>Error loading activity log. Please try again.').show();
        }
    });
}

// Initialize on document ready
$(document).ready(function() {
    initGroupManagement();
    
    // Override the existing group info button click handler
    $('#group-info-btn').off('click').on('click', function() {
        if (!currentRecipients || !currentRecipients.startsWith('group-')) return;
        
        const groupId = currentRecipients.split('-')[1];
        if (groupId) {
            loadGroupInfo(groupId);
        }
    });
    
    // Socket event handlers for pinned messages
    socket.on('message_pinned', function(data) {
        // If we're viewing the group info modal for this group, refresh pinned messages
        if (currentGroupId && currentGroupId == data.group_id) {
            loadPinnedMessages(currentGroupId);
        }
        
        // Show notification
        showPopup({
            title: 'Message Pinned',
            message: `${data.pinned_by} pinned a message to the group.`,
            icon: 'info',
            autoClose: true,
            autoCloseDelay: 3000
        });
    });
    
    socket.on('message_unpinned', function(data) {
        // If we're viewing the group info modal for this group, refresh pinned messages
        if (currentGroupId && currentGroupId == data.group_id) {
            loadPinnedMessages(currentGroupId);
        }
    });
    
    // Add CSS for timeline
    const timelineCSS = `
    .timeline {
        position: relative;
        padding: 20px 0;
    }
    .timeline:before {
        content: '';
        position: absolute;
        top: 0;
        left: 20px;
        height: 100%;
        width: 2px;
        background: #e9ecef;
    }
    .timeline-item {
        position: relative;
        margin-bottom: 30px;
        padding-left: 60px;
    }
    .timeline-icon {
        position: absolute;
        left: 0;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #f8f9fa;
        border: 2px solid #e9ecef;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1;
    }
    .timeline-content {
        padding: 15px;
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
    }
    .highlight-message {
        animation: highlight-pulse 2s;
    }
    @keyframes highlight-pulse {
        0% { box-shadow: 0 0 0 0 rgba(13, 110, 253, 0.7); }
        70% { box-shadow: 0 0 0 10px rgba(13, 110, 253, 0); }
        100% { box-shadow: 0 0 0 0 rgba(13, 110, 253, 0); }
    }
    .card-file-preview {
        height: 120px;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
    }
    .file-preview {
        max-height: 100%;
        max-width: 100%;
        object-fit: contain;
    }
    `;
    
    $('<style>').text(timelineCSS).appendTo('head');
});

// Update group settings
function updateGroupSettings() {
    if (!currentGroupId) {
        return;
    }
    
    // Get form values
    const name = $('#edit-group-name').val().trim();
    const description = $('#edit-group-description').val().trim();
    const adminOnly = $('#admin-only-toggle').is(':checked');
    
    if (!name) {
        showPopup({
            title: 'Error',
            message: 'Group name is required.',
            icon: 'error'
        });
        return;
    }
    
    // Store the current group ID to ensure it doesn't change during the update
    const groupIdToUpdate = currentGroupId;
    
    // Show loading state
    const $btn = $('#group-settings-form button[type="submit"]');
    const originalText = $btn.text();
    $btn.html('<i class="bi bi-hourglass-split"></i> Saving...').prop('disabled', true);
    
    // Update both group info and admin-only setting in a single call
    console.log('Updating group settings:', { name, description, adminOnly, groupId: groupIdToUpdate });
    
    $.ajax({
        url: `/api/groups/${groupIdToUpdate}/update`,
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ 
            name: name,
            description: description,
            admin_only: adminOnly
        }),
        success: function(response) {
            console.log('Group update response:', response);
            if (response.success) {
                // Update the UI with new values immediately
                $('#group-info-name').text(name);
                $('#group-info-description').text(description || 'No description available');
                
                // Update the form values to match
                $('#edit-group-name').val(name);
                $('#edit-group-description').val(description);
                $('#admin-only-toggle').prop('checked', adminOnly);
                
                // Show success message
                showPopup({
                    title: 'Settings Saved',
                    message: 'Group settings have been updated successfully.',
                    icon: 'success'
                });
                
                // Update the group name in the sidebar without requiring a full refresh
                $(`.group-item[data-group-id="${groupIdToUpdate}"] span`).text(name);
                
                // Also refresh the full group list in the sidebar
                if (typeof window.refreshGroupsList === 'function') {
                    window.refreshGroupsList();
                }
            } else {
                console.error('Group update failed:', response.error);
                showPopup({
                    title: 'Error',
                    message: response.error || 'Failed to update group settings.',
                    icon: 'error'
                });
            }
        },
        error: function(xhr, status, error) {
            console.error('Group update error:', xhr.responseText, status, error);
            showPopup({
                title: 'Error',
                message: 'Failed to update group settings. Please try again.',
                icon: 'error'
            });
        },
        complete: function() {
            // Reset button
            $btn.html(originalText).prop('disabled', false);
        }
    });
}