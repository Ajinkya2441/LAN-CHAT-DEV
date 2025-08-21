
from flask import Flask, render_template, request, redirect, url_for, session, send_from_directory, jsonify, abort, send_file, flash
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
import os
import socket
from datetime import datetime, timedelta
from cryptography.fernet import Fernet
import base64
from sqlalchemy import or_, and_
import uuid
from PIL import Image
import io

app = Flask(__name__)
app.config['SECRET_KEY'] = 'supersecretkey'  # Change this for production
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
app.config['UPLOAD_FOLDER'] = 'static/uploads/'
app.config['PROFILE_PHOTO_FOLDER'] = 'static/profile_photos/'
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024 * 1024 # 10 GB
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)

# Force no-cache for dynamic pages so re-click always fetches fresh HTML
@app.after_request
def add_no_cache_headers(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

def get_or_create_key():
    key_file = 'instance/chat.key'
    if not os.path.exists('instance'):
        os.makedirs('instance')
    if os.path.exists(key_file):
        with open(key_file, 'rb') as f:
            return f.read()
    else:
        key = Fernet.generate_key()
        with open(key_file, 'wb') as f:
            f.write(key)
        return key
 
# Initialize Fernet cipher
FERNET_KEY = get_or_create_key()
cipher_suite = Fernet(FERNET_KEY)

# Password helpers

def get_decrypted_password(user):
    token = user.password
    if isinstance(token, str):
        token = token.encode('utf-8')
    return cipher_suite.decrypt(token).decode('utf-8')


def set_encrypted_password(user, plain):
    """Encrypt and persist password as UTF-8 string (not bytes) for consistency."""
    token = cipher_suite.encrypt(plain.encode('utf-8'))  # returns bytes
    if isinstance(token, bytes):
        token = token.decode('utf-8')  # store URL-safe base64 string
    user.password = token

# Add Jinja2 filter for profile photos
@app.template_filter('profile_photo_url')
def profile_photo_url_filter(username):
    """Jinja2 filter to get profile photo URL."""
    user = User.query.filter_by(username=username).first()
    if user and user.profile_photo:
        return url_for('serve_profile_photo', filename=user.profile_photo)
    else:
        return url_for('static', filename='img/default_profile.png')
 
def encrypt_message(message):
    if not message:
        return message
    return cipher_suite.encrypt(message.encode()).decode()
 
def decrypt_message(encrypted_message):
    if not encrypted_message:
        return encrypted_message
    try:
        return cipher_suite.decrypt(encrypted_message.encode()).decode()
    except:
        return "Message decryption failed"
 
 

ALLOWED_EXTENSIONS = {'pdf', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'mp4', 'webm', 'mov', 'avi', 'mkv', 'zip', 'rar', '7z', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'mp3', 'wav', 'ogg', 'svg', 'heic', 'jfif', 'py','ipynb','html','css','js','json','xml','yaml','yml','md','markdown','exe','apk','iso','tar', 'msi'}

db = SQLAlchemy(app)
# Use eventlet for async_mode (required for Flask-SocketIO real-time features)
socketio = SocketIO(app, async_mode='eventlet')

# --- Database Models ---

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password = db.Column(db.String(128), nullable=False)  # New: store hashed password
    online = db.Column(db.Boolean, default=False)
    is_admin = db.Column(db.Boolean, default=False)  # New: admin flag
    created_by = db.Column(db.String(80), nullable=True)  # New: who created this user (admin username)
    profile_photo = db.Column(db.String(255), nullable=True)  # New: profile photo filename
    
    def __init__(self, username, password, online=False, is_admin=False, created_by=None, profile_photo=None):
        self.username = username
        self.password = password
        self.online = online
        self.is_admin = is_admin
        self.created_by = created_by
        self.profile_photo = profile_photo

class UserRequest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password = db.Column(db.String(128), nullable=False)  # store hashed password
    requested_by = db.Column(db.String(80), nullable=True)  # who requested (self or admin)
    status = db.Column(db.String(20), default='pending')  # pending, approved, rejected
    approved_by = db.Column(db.String(80), nullable=True)  # admin who approved
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    
    def __init__(self, username, password, requested_by=None, status='pending', approved_by=None):
        self.username = username
        self.password = password
        self.requested_by = requested_by
        self.status = status
        self.approved_by = approved_by

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sender = db.Column(db.String(80), nullable=False)
    recipients = db.Column(db.String(255), nullable=False)  # comma-separated usernames or 'all'
    content = db.Column(db.Text, nullable=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    file_id = db.Column(db.Integer, db.ForeignKey('file.id'), nullable=True)
    status = db.Column(db.String(20), default='sent')  # 'sent' or 'read'
    reply_to = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=True)  # New: replied message id
    reactions = db.Column(db.Text, nullable=True)  # New: JSON string of reactions
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=True)  # New: group message support
    
    def __init__(self, sender, recipients, content=None, file_id=None, status='sent', reply_to=None, reactions=None, group_id=None):
        self.sender = sender
        self.recipients = recipients
        self.content = content
        self.file_id = file_id
        self.status = status
        self.reply_to = reply_to
        self.reactions = reactions
        self.group_id = group_id

class HiddenMessage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    msg_id = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=False)
    username = db.Column(db.String(80), db.ForeignKey('user.username'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    __table_args__ = (
        db.UniqueConstraint('msg_id', 'username', name='uniq_msg_user_hide'),
    )

class File(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    filename = db.Column(db.String(255), nullable=False)
    original_name = db.Column(db.String(255), nullable=False)
    uploader = db.Column(db.String(80), nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    mimetype = db.Column(db.String(80), nullable=False)
    
    def __init__(self, filename, original_name, uploader, mimetype):
        self.filename = filename
        self.original_name = original_name
        self.uploader = uploader
        self.mimetype = mimetype

class Group(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.String(255), nullable=True)  # New: group description
    icon = db.Column(db.String(255), nullable=True)
    created_by = db.Column(db.String(80), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    admin_only = db.Column(db.Boolean, default=False)  # New: only admins can send messages
    
    def __init__(self, name, created_by, description=None, icon=None, admin_only=False):
        self.name = name
        self.description = description
        self.icon = icon
        self.created_by = created_by
        self.admin_only = admin_only

class GroupMember(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=False)
    username = db.Column(db.String(80), db.ForeignKey('user.username'), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    role = db.Column(db.String(50), default='member')  # member, moderator, admin, etc.
    joined_at = db.Column(db.DateTime, default=datetime.utcnow)
    notification_preference = db.Column(db.String(20), default='all')  # all, mentions, none
    
    def __init__(self, group_id, username, is_admin=False, role='member', notification_preference='all'):
        self.group_id = group_id
        self.username = username
        self.is_admin = is_admin
        self.role = role
        self.notification_preference = notification_preference

class PasswordResetRequest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), db.ForeignKey('user.username'), nullable=False)
    status = db.Column(db.String(20), default='pending')  # pending, approved, rejected
    requested_at = db.Column(db.DateTime, default=datetime.utcnow)
    approved_by = db.Column(db.String(80), nullable=True)
    approved_at = db.Column(db.DateTime, nullable=True)
    
    def __init__(self, username, status='pending', approved_by=None):
        self.username = username
        self.status = status
        self.approved_by = approved_by

# --- In-memory set to track online users ---
online_users = set()

# --- Helper Functions ---
def allowed_file(filename):
    """Check if the file extension is allowed."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def get_host_ip():
    """Get the local IP address of the host for LAN access."""
    try:
        return socket.gethostbyname(socket.gethostname())
    except:
        return 'localhost'

def allowed_profile_photo(filename):
    """Check if the file is a valid image for profile photos."""
    if not filename:
        return False
    allowed_extensions = {'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'}
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in allowed_extensions

def process_profile_photo(file, username):
    """Process and save a profile photo."""
    if not file or not allowed_profile_photo(file.filename):
        return None, "Invalid file type. Please upload a valid image (JPG, PNG, GIF, BMP, WEBP)."
    
    try:
        # Create profile photos directory if it doesn't exist
        profile_folder = app.config['PROFILE_PHOTO_FOLDER']
        if not os.path.exists(profile_folder):
            os.makedirs(profile_folder)
        
        # Generate unique filename
        file_extension = file.filename.rsplit('.', 1)[1].lower()
        filename = f"{username}_{uuid.uuid4().hex[:8]}.{file_extension}"
        filepath = os.path.join(profile_folder, filename)
        
        # Open and process the image
        image = Image.open(file.stream)
        
        # Convert RGBA to RGB if necessary
        if image.mode in ('RGBA', 'LA', 'P'):
            # Create a white background
            background = Image.new('RGB', image.size, (255, 255, 255))
            if image.mode == 'P':
                image = image.convert('RGBA')
            background.paste(image, mask=image.split()[-1] if image.mode == 'RGBA' else None)
            image = background
        
        # Resize image to 300x300 (square aspect ratio)
        image = image.resize((300, 300), Image.Resampling.LANCZOS)
        
        # Save the processed image
        image.save(filepath, format='JPEG', quality=85, optimize=True)
        
        return filename, None
        
    except Exception as e:
        return None, f"Error processing image: {str(e)}"

def get_profile_photo_url(username):
    """Get the profile photo URL for a user."""
    user = User.query.filter_by(username=username).first()
    if user and user.profile_photo:
        return url_for('serve_profile_photo', filename=user.profile_photo)
    else:
        return url_for('static', filename='img/default_profile.png')

def allowed_group_photo(filename):
    """Check if the file is a valid image for group photos."""
    if not filename:
        return False
    allowed_extensions = {'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'}
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in allowed_extensions

def process_group_photo(file, group_name):
    """Process and save a group photo."""
    if not file or not allowed_group_photo(file.filename):
        return None, "Invalid file type. Please upload a valid image (JPG, PNG, GIF, BMP, WEBP)."
    
    try:
        # Create group photos directory if it doesn't exist
        group_folder = 'static/group_photos/'
        if not os.path.exists(group_folder):
            os.makedirs(group_folder)
        
        # Generate unique filename with jpg extension (we save as JPEG)
        filename = f"group_{group_name}_{uuid.uuid4().hex[:8]}.jpg"
        filepath = os.path.join(group_folder, filename)
        
        # Open and process the image
        image = Image.open(file.stream)
        
        # Convert RGBA/Palette to RGB if necessary
        if image.mode in ('RGBA', 'LA', 'P'):
            background = Image.new('RGB', image.size, (255, 255, 255))
            if image.mode == 'P':
                image = image.convert('RGBA')
            background.paste(image, mask=image.split()[-1] if image.mode == 'RGBA' else None)
            image = background
        else:
            # Ensure RGB for JPEG
            if image.mode != 'RGB':
                image = image.convert('RGB')
        
        # Resize image to 300x300 (square aspect ratio)
        image = image.resize((300, 300), Image.Resampling.LANCZOS)
        
        # Save the processed image as JPEG
        image.save(filepath, format='JPEG', quality=85, optimize=True)
        
        return filename, None
        
    except Exception as e:
        return None, f"Error processing image: {str(e)}"

def get_group_photo_url(group_id):
    """Get the group photo URL for a group."""
    group = Group.query.get(group_id)
    if group and group.icon and group.icon.startswith('group_'):
        return url_for('serve_group_photo', filename=group.icon)
    else:
        return url_for('static', filename='img/default_profile.png')

def log_group_activity(group_id, action_type, actor, target=None, details=None):
    """Log an activity in the group activity log and send system message to chat."""
    try:
        import json
        details_str = json.dumps(details) if details else None
        activity = GroupActivity(
            group_id=group_id,
            action_type=action_type,
            actor=actor,
            target=target,
            details=details_str
        )
        db.session.add(activity)
        
        # Create system message for the group chat
        system_message = create_activity_message(action_type, actor, target, details)
        if system_message:
            # Create a system message in the group chat
            message = Message(
                sender='System',
                recipients=f'group-{group_id}',
                content=encrypt_message(system_message),
                group_id=group_id
            )
            db.session.add(message)
        
        db.session.commit()
        
        # Emit the system message to group members via SocketIO if available
        if system_message:
            try:
                from flask_socketio import emit
                socketio.emit('new_message', {
                    'sender': 'System',
                    'content': system_message,
                    'timestamp': message.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
                    'recipients': f'group-{group_id}',
                    'message_id': message.id,
                    'is_system': True
                }, room=f'group-{group_id}')
            except:
                pass  # SocketIO might not be available in all contexts
                
    except Exception as e:
        print(f"Error logging group activity: {e}")
        # Don't fail the main operation if logging fails
        pass

def create_activity_message(action_type, actor, target=None, details=None):
    """Create a human-readable system message for group activities."""
    if action_type == 'member_added':
        if details and details.get('is_admin'):
            return f"👤 {actor} added {target} to the group as an admin"
        return f"👤 {actor} added {target} to the group"
    
    elif action_type == 'member_removed':
        return f"👤 {actor} removed {target} from the group"
    
    elif action_type == 'admin_status_changed':
        if details and details.get('is_admin'):
            return f"🛡️ {actor} made {target} an admin"
        return f"🛡️ {actor} removed admin status from {target}"
    
    elif action_type == 'photo_updated':
        return f"📷 {actor} updated the group photo"
    
    elif action_type == 'photo_removed':
        return f"📷 {actor} removed the group photo"
    
    elif action_type == 'group_name_changed':
        if details:
            return f"✏️ {actor} changed group name from \"{details.get('old_name')}\" to \"{details.get('new_name')}\""
        return f"✏️ {actor} changed the group name"
    
    elif action_type == 'description_added':
        if details and details.get('description'):
            return f"📝 {actor} added group description: \"{details.get('description')}\""
        return f"📝 {actor} added a group description"
    
    elif action_type == 'description_changed':
        if details:
            return f"📝 {actor} changed group description from \"{details.get('old_description')}\" to \"{details.get('new_description')}\""
        return f"📝 {actor} changed the group description"
    
    elif action_type == 'description_removed':
        return f"📝 {actor} removed the group description"
    
    elif action_type == 'admin_only_changed':
        if details and details.get('admin_only'):
            return f"🔒 {actor} restricted messaging to admins only"
        return f"🔓 {actor} allowed all members to send messages"
    
    elif action_type == 'group_created':
        return f"🎉 {actor} created this group"
    
    # Return None for activities that shouldn't show in chat
    return None

# --- Routes ---
@app.route('/')
def index():
    """Welcome page that redirects to dashboard or login."""
    if 'username' in session:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    """User login page. Requires username and password."""
    error = None
    if request.method == 'POST':
        username = request.form['username'].strip()
        password = request.form.get('password', '')
        user = User.query.filter_by(username=username).first()
        if not user:
            error = 'User not found or not approved.'
        else:
            try:
                if get_decrypted_password(user) != password:
                    error = 'Invalid password.'
            except Exception:
                error = 'Account password cannot be verified. Contact admin.'

        if not error:
            session['username'] = username
            session['is_admin'] = user.is_admin
            session.permanent = True  # Make session persistent
            user.online = True
            db.session.commit()
            return redirect(url_for('dashboard'))
    return render_template('login.html', error=error, host_ip=get_host_ip())

@app.route('/chat')
def chat():
    """Redirect to the new chats page for backward compatibility."""
    if 'username' not in session:
        return redirect(url_for('login'))
    return redirect(url_for('chats'))

@app.route('/dashboard')
def dashboard():
    """Main dashboard page. Requires login."""
    if 'username' not in session:
        return redirect(url_for('login'))
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip())

@app.route('/chats')
def chats():
    """Chats page - shows the chat interface."""
    if 'username' not in session:
        return redirect(url_for('login'))
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='chats')

@app.route('/groups')
def groups_ui():
    """Groups page - show groups section in dashboard."""
    if 'username' not in session:
        return redirect(url_for('login'))
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='groups')

@app.route('/files')
def files_ui():
    """Files page - show files section in dashboard."""
    if 'username' not in session:
        return redirect(url_for('login'))
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='files')

@app.route('/manage-account', methods=['GET', 'POST'])
def manage_account():
    """Manage Account page - allows users to view and edit their account details."""
    if 'username' not in session:
        return redirect(url_for('login'))
    
    user = User.query.filter_by(username=session['username']).first()
    if not user:
        return redirect(url_for('login'))
    
    message = None
    if request.method == 'POST':
        action = request.form.get('action')
        if action == 'upload_profile_photo':
            if 'profile_photo' not in request.files:
                flash('No file selected.', 'error')
                return redirect(url_for('manage_account'))
            
            file = request.files['profile_photo']
            if file.filename == '':
                flash('No file selected.', 'error')
                return redirect(url_for('manage_account'))
            
            # Process the profile photo
            filename, error = process_profile_photo(file, session['username'])
            if error:
                flash(error, 'error')
                return redirect(url_for('manage_account'))
            
            # Delete old profile photo if it exists
            if user.profile_photo:
                old_photo_path = os.path.join(app.config['PROFILE_PHOTO_FOLDER'], user.profile_photo)
                try:
                    if os.path.exists(old_photo_path):
                        os.remove(old_photo_path)
                except Exception as e:
                    print(f"Error deleting old profile photo: {e}")
            
            # Update user's profile photo
            user.profile_photo = filename
            db.session.commit()
            try:
                socketio.emit('profile_photo_updated', {
                    'username': user.username,
                    'photo_url': url_for('api_profile_photo', username=user.username)
                })
            except Exception as e:
                print(f"Socket emit error: {e}")
            flash('Profile photo updated successfully!', 'success')
            return redirect(url_for('manage_account'))
        
        elif action == 'remove_profile_photo':
            if user.profile_photo:
                old_photo_path = os.path.join(app.config['PROFILE_PHOTO_FOLDER'], user.profile_photo)
                try:
                    if os.path.exists(old_photo_path):
                        os.remove(old_photo_path)
                except Exception as e:
                    print(f"Error deleting profile photo: {e}")
                
                user.profile_photo = None
                db.session.commit()
                try:
                    socketio.emit('profile_photo_updated', {
                        'username': user.username,
                        'photo_url': url_for('api_profile_photo', username=user.username)
                    })
                except Exception as e:
                    print(f"Socket emit error: {e}")
                flash('Profile photo removed successfully!', 'success')
            else:
                flash('No profile photo to remove.', 'info')
            return redirect(url_for('manage_account'))
        
        elif action == 'change_password':
            # Handle password change with validation
            current_password = request.form.get('current_password', '')
            new_password = request.form.get('new_password', '')
            confirm_password = request.form.get('confirm_password', '')

            # Basic presence checks
            if not current_password or not new_password or not confirm_password:
                flash('All password fields are required.', 'error')
                return redirect(url_for('manage_account'))

            # Verify current password
            try:
                if get_decrypted_password(user) != current_password:
                    flash('Current password is incorrect.', 'error')
                    return redirect(url_for('manage_account'))
            except Exception:
                flash('Your account password cannot be verified. Contact admin.', 'error')
                return redirect(url_for('manage_account'))

            # Validate new password
            if new_password != confirm_password:
                flash('New password and confirm password do not match.', 'error')
                return redirect(url_for('manage_account'))
            if len(new_password) < 8:
                flash('New password must be at least 8 characters long.', 'error')
                return redirect(url_for('manage_account'))
            if new_password == current_password:
                flash('New password must be different from the current password.', 'error')
                return redirect(url_for('manage_account'))

            # Optional complexity checks (uncomment to enforce):
            # import re
            # if not re.search(r"[A-Za-z]", new_password) or not re.search(r"\d", new_password):
            #     flash('Password must include at least one letter and one number.', 'error')
            #     return redirect(url_for('manage_account'))

            # Persist password
            set_encrypted_password(user, new_password)
            db.session.commit()
            flash('Password updated successfully.', 'success')
            return redirect(url_for('manage_account'))
    
    return render_template('dashboard.html', 
                         username=session['username'], 
                         host_ip=get_host_ip(), 
                         active_section='manage-account',
                         user=user,
                         message=message)

@app.route('/profile_photo/<filename>')
def serve_profile_photo(filename):
    """Serve profile photos."""
    try:
        profile_folder = app.config['PROFILE_PHOTO_FOLDER']
        return send_from_directory(profile_folder, filename)
    except Exception as e:
        # Return default profile photo if file not found
        return send_from_directory('static/img', 'default_profile.png')

@app.route('/api/profile_photo/<username>')
def api_profile_photo(username):
    """API endpoint to get profile photo by username."""
    try:
        user = User.query.filter_by(username=username).first()
        if user and user.profile_photo:
            profile_folder = app.config['PROFILE_PHOTO_FOLDER']
            return send_from_directory(profile_folder, user.profile_photo)
        else:
            # Return default profile photo
            return send_from_directory('static/img', 'default_profile.png')
    except Exception as e:
        # Return default profile photo on any error
        return send_from_directory('static/img', 'default_profile.png')

@app.route('/group_photo/<filename>')
def serve_group_photo(filename):
    """Serve group photos."""
    try:
        group_folder = 'static/group_photos/'
        return send_from_directory(group_folder, filename)
    except Exception as e:
        # Return default group photo if file not found
        return send_from_directory('static/img', 'default_group.svg')

@app.route('/api/group_photo/<int:group_id>')
def api_group_photo(group_id):
    """API endpoint to get group photo by group ID."""
    try:
        group = Group.query.get(group_id)
        if group and group.icon and group.icon.startswith('group_'):
            group_folder = 'static/group_photos/'
            return send_from_directory(group_folder, group.icon)
        else:
            # Return default group image
            return send_from_directory('static/img', 'default_group.png')
    except Exception as e:
        # Return default group image on any error
        return send_from_directory('static/img', 'default_group.png')

@app.route('/api/groups/<int:group_id>', methods=['GET'])
def api_group_info(group_id):
    """Return group info for the Group Info modal."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401

    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404

    # Compute is_admin for current user
    username = session['username']
    gm = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    is_admin = bool(gm and getattr(gm, 'is_admin', False))

    # Always provide a resilient icon URL like user profile API
    # This endpoint serves the actual image or a default if missing
    icon_url = url_for('api_group_photo', group_id=group.id)

    # Members payload
    members = []
    for m in GroupMember.query.filter_by(group_id=group_id).all():
        members.append({
            'username': m.username,
            'is_admin': bool(getattr(m, 'is_admin', False)),
            'role': getattr(m, 'role', None),
            'notification_preference': getattr(m, 'notification_preference', None)
        })

    created_at_str = None
    try:
        created_at_str = group.created_at.strftime('%Y-%m-%d %H:%M') if getattr(group, 'created_at', None) else None
    except Exception:
        created_at_str = None

    return jsonify({
        'id': group.id,
        'name': group.name,
        'description': getattr(group, 'description', '') or '',
        'icon': icon_url,
        'created_by': getattr(group, 'created_by', ''),
        'created_at': created_at_str or '',
        'admin_only': bool(getattr(group, 'admin_only', False)),
        'is_admin': is_admin,
        'members': members
    })

@app.route('/api/groups/<int:group_id>/upload_photo', methods=['POST'])
def upload_group_photo(group_id):
    """Upload a group photo (admin only)."""
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    
    username = session['username']
    
    # Check if group exists and user is admin
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'success': False, 'error': 'Group not found'}), 404
    
    admin = GroupMember.query.filter_by(group_id=group_id, username=username, is_admin=True).first()
    if not admin:
        return jsonify({'success': False, 'error': 'Only admins can change group photo'}), 403
    
    # Check if a file was uploaded
    if 'group_photo' not in request.files:
        return jsonify({'success': False, 'error': 'No photo uploaded'}), 400
    
    file = request.files['group_photo']
    if file.filename == '':
        return jsonify({'success': False, 'error': 'No photo selected'}), 400
    
    # Process the group photo
    filename, error = process_group_photo(file, group.name.replace(' ', '_'))
    if error:
        return jsonify({'success': False, 'error': error}), 400
    
    # Remove old group photo if exists
    if group.icon and group.icon.startswith('group_'):
        old_photo_path = os.path.join('static/group_photos/', group.icon)
        if os.path.exists(old_photo_path):
            try:
                os.remove(old_photo_path)
            except Exception as e:
                print(f"Error removing old group photo: {e}")
    
    # Update group icon
    group.icon = filename
    db.session.commit()
    
    # Log activity
    log_group_activity(group_id, 'photo_updated', username, details={'photo_filename': filename})
    
    return jsonify({
        'success': True,
        'photo_url': url_for('api_group_photo', group_id=group_id),
        'filename': filename
    })

@app.route('/api/groups/<int:group_id>/remove_photo', methods=['POST'])
def remove_group_photo(group_id):
    """Remove the current group photo (admin only)."""
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    
    username = session['username']
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'success': False, 'error': 'Group not found'}), 404
    
    admin = GroupMember.query.filter_by(group_id=group_id, username=username, is_admin=True).first()
    if not admin:
        return jsonify({'success': False, 'error': 'Only admins can remove group photo'}), 403
    
    if group.icon and group.icon.startswith('group_'):
        old_photo_path = os.path.join('static/group_photos/', group.icon)
        if os.path.exists(old_photo_path):
            try:
                os.remove(old_photo_path)
            except Exception as e:
                print(f"Error removing old group photo: {e}")
    
    group.icon = None
    db.session.commit()
    
    try:
        log_group_activity(group_id, 'photo_removed', username)
    except Exception:
        pass
    
    return jsonify({'success': True})

@app.route('/add-user', methods=['GET', 'POST'])
def add_user():
    """Add User page. Requires admin login."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    
    message = None
    if request.method == 'POST':
        action = request.form.get('action')
        if action == 'create_user':
            new_username = request.form.get('new_username', '').strip().title()
            new_password = request.form.get('new_password')
            is_admin = bool(request.form.get('new_is_admin'))
            if not new_username or not new_password:
                flash('Username and password required.', 'error')
                return redirect(url_for('add_user'))
            elif User.query.filter_by(username=new_username).first():
                flash('Username already exists.', 'error')
                return redirect(url_for('add_user'))
            else:
                user = User(
                    username=new_username,
                    password='',  # set after encrypting to ensure string storage
                    is_admin=is_admin,
                    created_by=session['username']
                )
                set_encrypted_password(user, new_password)
                db.session.add(user)
                db.session.commit()
                flash(f'User {new_username} created successfully!', 'success')
                return redirect(url_for('add_user'))
    
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='add-user', message=message)

@app.route('/pending-requests', methods=['GET', 'POST'])
def pending_requests():
    """Pending Requests page. Requires admin login."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    
    message = None
    if request.method == 'POST':
        action = request.form.get('action')
        req_id = request.form.get('req_id')
        req = UserRequest.query.get(req_id) if req_id else None
        if req and action == 'approve':
            user = User(
                username=req.username,
                password=req.password,
                is_admin=False,
                created_by=session['username']
            )
            db.session.add(user)
            req.status = 'approved'
            req.approved_by = session['username']
            db.session.commit()
            flash(f'Request for {req.username} approved successfully!', 'success')
            return redirect(url_for('pending_requests'))
        elif req and action == 'reject':
            req.status = 'rejected'
            req.approved_by = session['username']
            db.session.commit()
            flash(f'Request for {req.username} rejected successfully!', 'success')
            return redirect(url_for('pending_requests'))
    
    requests = UserRequest.query.order_by(UserRequest.timestamp.desc()).all()
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='pending-requests', requests=requests, message=message)

@app.route('/reset-requests', methods=['GET', 'POST'])
def reset_requests():
    """Password Reset Requests page. Requires admin login."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    
    message = None
    if request.method == 'POST':
        action = request.form.get('action')
        if action == 'approve_reset':
            reset_id = request.form.get('reset_id')
            req = PasswordResetRequest.query.get(reset_id)
            if req and req.status == 'pending':
                req.status = 'approved'
                req.approved_by = session['username']
                req.approved_at = datetime.utcnow()
                db.session.commit()
                flash(f'Password reset for {req.username} approved. Tell the user to visit /reset_password?username={req.username} to set a new password.', 'success')
                return redirect(url_for('reset_requests'))
        elif action == 'reject_reset':
            reset_id = request.form.get('reset_id')
            req = PasswordResetRequest.query.get(reset_id)
            if req and req.status == 'pending':
                req.status = 'rejected'
                req.approved_by = session['username']
                req.approved_at = datetime.utcnow()
                db.session.commit()
                flash(f'Password reset for {req.username} rejected successfully!', 'success')
                return redirect(url_for('reset_requests'))
    
    reset_requests = PasswordResetRequest.query.order_by(PasswordResetRequest.requested_at.desc()).all()
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='reset-requests', reset_requests=reset_requests, message=message)

@app.route('/all-users', methods=['GET', 'POST'])
def all_users():
    """All Users page. Requires admin login."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    
    message = None
    if request.method == 'POST':
        action = request.form.get('action')
        user_id = request.form.get('user_id')
        user = User.query.get(user_id)
        
        if user:
            if action == 'delete_user':
                if not user.is_admin:
                    db.session.delete(user)
                    db.session.commit()
                    flash(f'User {user.username} deleted successfully!', 'success')
                    return redirect(url_for('all_users'))
                else:
                    flash(f'Cannot delete admin user {user.username}.', 'error')
                    return redirect(url_for('all_users'))
            elif action == 'promote_admin':
                if not user.is_admin:
                    user.is_admin = True
                    user.created_by = session['username']
                    db.session.commit()
                    flash(f'User {user.username} promoted to admin successfully!', 'success')
                    return redirect(url_for('all_users'))
                else:
                    flash(f'User {user.username} is already an admin.', 'error')
                    return redirect(url_for('all_users'))
            elif action == 'demote_admin':
                if user.is_admin:
                    # Prevent demoting the last admin
                    admin_count = User.query.filter_by(is_admin=True).count()
                    if admin_count > 1:
                        user.is_admin = False
                        db.session.commit()
                        flash(f'User {user.username} demoted from admin successfully!', 'success')
                        return redirect(url_for('all_users'))
                    else:
                        flash(f'Cannot demote {user.username}. At least one admin must remain in the system.', 'error')
                        return redirect(url_for('all_users'))
                else:
                    flash(f'User {user.username} is not an admin.', 'error')
                    return redirect(url_for('all_users'))
    
    users = User.query.all()
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='all-users', users=users, message=message)

@app.route('/admins')
def admins():
    """Admins page. Requires admin login."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    
    users = User.query.all()
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='admins', users=users)

@app.route('/logout')
def logout():
    """Logout the user and update online status."""
    username = session.get('username')
    if username:
        user = User.query.filter_by(username=username).first()
        if user:
            user.online = False
            db.session.commit()
        online_users.discard(username)
        session.pop('username', None)
    return redirect(url_for('login'))

@app.route('/popup-demo')
def popup_demo():
    """Demo page for the enhanced popup functionality."""
    return render_template('popup_demo.html')

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    """Serve uploaded files from the uploads directory. If ?download=1, force download."""
    as_attachment = request.args.get('download') == '1'
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename, as_attachment=as_attachment)

@app.route('/history')
def history():
    """Return recent messages for the user, private chat, or group chat (no public chat), excluding messages the user hid."""
    import json
    if 'username' not in session:
        return jsonify([])
    username = session['username']
    filter_user = request.args.get('user')
    group_id = request.args.get('group_id')

    # Exclude messages hidden by this user
    hidden_subq = db.session.query(HiddenMessage.msg_id).filter(HiddenMessage.username == username)

    if group_id:
        group_room = f'group-{group_id}'
        msgs = (
            Message.query
            .filter_by(recipients=group_room)
            .filter(~Message.id.in_(hidden_subq))
            .order_by(Message.timestamp.desc())
            .limit(50).all()
        )
    elif filter_user == username:
        msgs = (
            Message.query
            .filter(
                or_(
                    Message.sender == username,
                    Message.recipients.like(f'%{username}%')
                ),
                Message.group_id == None
            )
            .filter(~Message.id.in_(hidden_subq))
            .order_by(Message.timestamp.desc())
            .limit(50).all()
        )
    elif filter_user and filter_user.startswith('group-'):
        msgs = (
            Message.query
            .filter_by(recipients=filter_user)
            .filter(~Message.id.in_(hidden_subq))
            .order_by(Message.timestamp.desc())
            .limit(50).all()
        )
    else:
        msgs = (
            Message.query
            .filter(
                or_(
                    and_(Message.sender == username, Message.recipients.like(f"%{filter_user}%")),
                    and_(Message.sender == filter_user, Message.recipients.like(f"%{username}%"))
                ),
                Message.group_id == None
            )
            .filter(~Message.id.in_(hidden_subq))
            .order_by(Message.timestamp.desc())
            .limit(50).all()
        )
    result = []
    for m in reversed(msgs):
        file_info = None
        if m.file_id:
            f = File.query.get(m.file_id)
            if f:
                file_info = {
                    'filename': f.filename,
                    'original_name': f.original_name,
                    'mimetype': f.mimetype
                }
        reply_msg = None
        if m.reply_to:
            reply = Message.query.get(m.reply_to)
            if reply:
                reply_msg = {
                    'id': reply.id,
                    'sender': reply.sender,
                    'content': decrypt_message(reply.content) if reply.content else '',
                    'timestamp': reply.timestamp.isoformat() + 'Z' if reply.timestamp else None
                }
        result.append({
            'id': m.id,
            'sender': m.sender,
            'recipients': m.recipients,
            'content': decrypt_message(m.content) if m.content else '',
            'timestamp': m.timestamp.isoformat() + 'Z' if m.timestamp else None,
            'file': file_info,
            'status': m.status,
            'reply_to': reply_msg,
            'reactions': json.loads(m.reactions) if m.reactions else {},
            'group_id': m.group_id
        })
    return jsonify(result)

@app.route('/search')
def search():
    """Search chats by name or message content (private and groups user belongs to)."""
    if 'username' not in session:
        return jsonify({'users': [], 'groups': []})
    q = (request.args.get('q') or '').strip().lower()
    if not q:
        return jsonify({'users': [], 'groups': []})
    username = session['username']
    user_matches = set()
    group_matches = set()
    # Private messages involving the user
    pm_msgs = Message.query.filter(
        Message.group_id == None,
        or_(
            Message.sender == username,
            Message.recipients.like(f"%{username}%")
        )
    ).order_by(Message.timestamp.desc()).limit(2000).all()
    for m in pm_msgs:
        if not m.content:
            continue
        try:
            dec = decrypt_message(m.content)
        except Exception:
            dec = ''
        if dec and q in dec.lower():
            if m.sender == username:
                for r in m.recipients.split(','):
                    r = r.strip()
                    if r and r != username:
                        user_matches.add(r)
            else:
                if m.sender != username:
                    user_matches.add(m.sender)
    # Group messages in groups the user belongs to
    gm_group_ids = [gm.group_id for gm in GroupMember.query.filter_by(username=username)]
    if gm_group_ids:
        grp_msgs = Message.query.filter(
            Message.group_id.in_(gm_group_ids)
        ).order_by(Message.timestamp.desc()).limit(2000).all()
        for m in grp_msgs:
            if not m.content:
                continue
            try:
                dec = decrypt_message(m.content)
            except Exception:
                dec = ''
            if dec and q in dec.lower():
                if m.group_id:
                    group_matches.add(str(m.group_id))
    return jsonify({'users': sorted(user_matches), 'groups': sorted(list(group_matches))})

@app.route('/users')
def users():
    """Return the list of currently online users."""
    users = User.query.filter_by(online=True).all()
    return jsonify([u.username for u in users])

@app.route('/users_status')
def users_status():
    """Return all users and their online status."""
    users = User.query.all()
    return jsonify([{ 'username': u.username, 'online': u.online } for u in users])

@app.route('/upload', methods=['POST'])
def upload():
    """Handle file uploads and save metadata to the database."""
    if 'username' not in session:
        return jsonify({'error': 'Login required'}), 403
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if not file.filename or file.filename == '' or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file'}), 400
    filename = secure_filename(file.filename)
    save_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    i = 1
    while os.path.exists(save_path):
        filename = f"{os.path.splitext(secure_filename(file.filename))[0]}_{i}{os.path.splitext(file.filename)[1]}"
        save_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        i += 1
    file.save(save_path)
    f = File(filename=filename, original_name=file.filename, uploader=session['username'], mimetype=file.mimetype)
    db.session.add(f)
    db.session.commit()
    return jsonify({'file_id': f.id, 'filename': filename, 'original_name': file.filename, 'mimetype': file.mimetype})

@app.route('/delete_message/<int:msg_id>', methods=['POST'])
def delete_message(msg_id):
    """Sender hard-deletes for everyone; recipient hides only for self."""
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    username = session['username']
    msg = Message.query.get(msg_id)
    if not msg:
        return jsonify({'success': False, 'error': 'Message not found'}), 404

    # Only sender/recipient/admin can act
    if not (msg.sender == username or username in msg.recipients.split(',') or username == 'admin'):
        return jsonify({'success': False, 'error': 'Not allowed'}), 403

    # Sender (or admin) → hard delete for everyone
    if username == msg.sender or username == 'admin':
        # If message has a file, delete the file too
        if msg.file_id:
            file = File.query.get(msg.file_id)
            if file:
                try:
                    os.remove(os.path.join(app.config['UPLOAD_FOLDER'], file.filename))
                except Exception:
                    pass
                db.session.delete(file)
        msg_data = {
            'msg_id': msg_id,
            'sender': msg.sender,
            'recipients': msg.recipients,
            'group_id': msg.group_id,
            'deleted_by': username
        }
        db.session.delete(msg)
        db.session.commit()

        # Notify all relevant users
        if msg.recipients == 'all':
            socketio.emit('message_deleted', msg_data)
        elif msg.recipients.startswith('group-'):
            socketio.emit('message_deleted', msg_data, to=msg.recipients)
        else:
            for recipient in msg.recipients.split(','):
                socketio.emit('message_deleted', msg_data, to=recipient.strip())
            socketio.emit('message_deleted', msg_data, to=msg.sender)
        return jsonify({'success': True, 'mode': 'hard'})

    # Recipient (not sender) → soft delete (hide only for this user)
    from sqlalchemy.exc import IntegrityError
    try:
        hide = HiddenMessage(msg_id=msg_id, username=username)
        db.session.add(hide)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        # Already hidden; proceed silently
    # Notify only this user to remove it from their view
    msg_data = {
        'msg_id': msg_id,
        'sender': msg.sender,
        'recipients': msg.recipients,
        'group_id': msg.group_id,
        'deleted_by': username
    }
    socketio.emit('message_deleted', msg_data, to=username)
    return jsonify({'success': True, 'mode': 'soft'})

@app.route('/delete_file/<int:file_id>', methods=['POST'])
def delete_file(file_id):
    """Delete a file and all messages referencing it.

    Allowed if:
    - user is the uploader
    - user is an admin
    - user is a sender/recipient of at least one message that references this file
      (for group messages, user must be a member of that group)
    """
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    username = session['username']
    is_admin = session.get('is_admin', False)

    file = File.query.get(file_id)
    if not file:
        return jsonify({'success': False, 'error': 'File not found'}), 404

    allowed = False
    if is_admin or file.uploader == username:
        allowed = True
    else:
        # Check involvement in any private message referencing this file
        pm_involved = Message.query.filter(
            Message.file_id == file_id
        ).filter(
            or_(
                Message.sender == username,
                and_(Message.recipients.isnot(None), Message.recipients.like(f'%{username}%'))
            )
        ).first()
        if pm_involved:
            allowed = True
        else:
            # Check group message involvement by membership
            grp_msg = Message.query.filter(
                Message.file_id == file_id,
                Message.group_id.isnot(None)
            ).first()
            if grp_msg:
                gm = GroupMember.query.filter_by(group_id=grp_msg.group_id, username=username).first()
                if gm:
                    allowed = True

    if not allowed:
        return jsonify({'success': False, 'error': 'Not allowed'}), 403

    try:
        os.remove(os.path.join(app.config['UPLOAD_FOLDER'], file.filename))
    except Exception:
        pass
    
    # Get all messages referencing this file for real-time notification
    affected_messages = Message.query.filter_by(file_id=file_id).all()
    affected_msg_data = []
    
    for msg in affected_messages:
        affected_msg_data.append({
            'msg_id': msg.id,
            'sender': msg.sender,
            'recipients': msg.recipients,
            'group_id': msg.group_id
        })
    
    # Remove all messages referencing this file
    Message.query.filter_by(file_id=file_id).delete()
    db.session.delete(file)
    db.session.commit()
    
    # 🔥 REAL-TIME: Notify all users about file and message deletions
    file_deleted_data = {
        'file_id': file_id,
        'filename': file.filename,
        'deleted_by': username,
        'affected_messages': affected_msg_data
    }
    
    # Notify all users who had access to messages with this file
    notified_users = set()
    for msg_data in affected_msg_data:
        if msg_data['recipients'] == 'all':
            # Broadcast to all users
            socketio.emit('file_deleted', file_deleted_data)
            break
        elif msg_data['recipients'].startswith('group-'):
            # Notify group members
            socketio.emit('file_deleted', file_deleted_data, to=msg_data['recipients'])
        else:
            # Notify private chat participants
            for recipient in msg_data['recipients'].split(','):
                if recipient.strip() not in notified_users:
                    socketio.emit('file_deleted', file_deleted_data, to=recipient.strip())
                    notified_users.add(recipient.strip())
            if msg_data['sender'] not in notified_users:
                socketio.emit('file_deleted', file_deleted_data, to=msg_data['sender'])
                notified_users.add(msg_data['sender'])
    
    return jsonify({'success': True})

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    """Signup page for new users. Requires username and password only."""
    error = None
    success = None
    if request.method == 'POST':
        username = request.form['username'].strip().title()
        password = request.form['password']
        # Removed app_password check
        if not username or not password:
            error = 'Username and password required.'
        elif User.query.filter_by(username=username).first() or UserRequest.query.filter_by(username=username).first():
            error = 'Username already exists or pending approval.'
        else:
            req = UserRequest(
                username=username,
                password=cipher_suite.encrypt(password.encode()),
                requested_by=username,
                status='pending'
            )
            db.session.add(req)
            db.session.commit()
            # Real-time: notify all admins
            socketio.emit('new_user_request', {'username': username, 'requested_by': username})
            success = 'Signup request submitted. Wait for admin approval.'
    return render_template('signup.html', error=error, success=success)

@app.route('/admin', methods=['GET', 'POST'])
def admin_dashboard():
    """Redirect to the new add-user page for backward compatibility."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    return redirect(url_for('add_user'))

@app.route('/api/groups', methods=['GET'])
def get_user_groups():
    """Return all groups the current user is a member of."""
    if 'username' not in session:
        return jsonify([])
    username = session['username']
    group_ids = [gm.group_id for gm in GroupMember.query.filter_by(username=username)]
    groups = Group.query.filter(Group.id.in_(group_ids)).all()
    result = []
    for g in groups:
        result.append({
            'id': g.id,
            'name': g.name,
            'icon': url_for('api_group_photo', group_id=g.id),
            'created_by': g.created_by,
            'created_at': g.created_at.strftime('%Y-%m-%d %H:%M')
        })
    return jsonify(result)

@app.route('/api/groups', methods=['POST'])
@app.route('/api/groups/', methods=['POST'])
def create_group():
    """Create a new group with name, description, members, admins, and optional icon."""
    if 'username' not in session:
        return jsonify({'error': 'Login required'}), 403
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    name = data.get('name')
    description = data.get('description')
    members = data.get('members', [])
    admins = data.get('admins', [])
    icon = data.get('icon')
    if not name or not members:
        return jsonify({'error': 'Name and members required'}), 400
    if session['username'] not in members:
        members.append(session['username'])
    if session['username'] not in admins:
        admins.append(session['username'])
    group = Group(name=name, description=description, icon=icon, created_by=session['username'])
    db.session.add(group)
    db.session.commit()
    # Add members and admins
    for m in set(members):
        gm = GroupMember(group_id=group.id, username=m, is_admin=(m in admins))
        db.session.add(gm)
    db.session.commit()
    
    # Log group creation activity
    log_group_activity(group.id, 'group_created', session['username'], 
                      details={'members': list(set(members)), 'admins': list(set(admins))})
    
    # Log member additions
    for m in set(members):
        if m != session['username']:  # Don't log creator adding themselves
            is_admin = m in admins
            log_group_activity(group.id, 'member_added', session['username'], m, 
                             details={'is_admin': is_admin})
    
    return jsonify({'success': True, 'group_id': group.id})

@app.route('/api/groups/<int:group_id>', methods=['GET'])
def get_group_info(group_id):
    """Get group info, members, and admins."""
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    members = GroupMember.query.filter_by(group_id=group_id).all()
    member_list = [{'username': m.username, 'is_admin': m.is_admin} for m in members]
    is_admin = False
    if 'username' in session:
        is_admin = any(m.username == session['username'] and m.is_admin for m in members)
    return jsonify({
        'id': group.id,
        'name': group.name,
        'description': group.description,
        'icon': group.icon,
        'created_by': group.created_by,
        'created_at': group.created_at.strftime('%Y-%m-%d %H:%M'),
        'members': member_list,
        'is_admin': is_admin,
        'admin_only': group.admin_only
    })

@app.route('/api/groups/<int:group_id>/add_member', methods=['POST'])
def add_group_member(group_id):
    """Add a member to a group (admin only)."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    admin = GroupMember.query.filter_by(group_id=group_id, username=session['username'], is_admin=True).first()
    if not admin:
        return jsonify({'error': 'Only admins can add members'}), 403
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    new_member = data.get('username')
    if not new_member:
        return jsonify({'error': 'Username required'}), 400
    if GroupMember.query.filter_by(group_id=group_id, username=new_member).first():
        return jsonify({'error': 'User already in group'}), 400
    gm = GroupMember(group_id=group_id, username=new_member, is_admin=False)
    db.session.add(gm)
    db.session.commit()
    
    # Log activity
    log_group_activity(group_id, 'member_added', session['username'], new_member)
    
    return jsonify({'success': True})

@app.route('/api/groups/<int:group_id>/remove_member', methods=['POST'])
def remove_group_member(group_id):
    """Remove a member from a group (admin only)."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    admin = GroupMember.query.filter_by(group_id=group_id, username=session['username'], is_admin=True).first()
    if not admin:
        return jsonify({'error': 'Only admins can remove members'}), 403
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    member = data.get('username')
    if not member:
        return jsonify({'error': 'Username required'}), 400
    gm = GroupMember.query.filter_by(group_id=group_id, username=member).first()
    if not gm:
        return jsonify({'error': 'User not in group'}), 400
    db.session.delete(gm)
    db.session.commit()
    
    # Log activity
    log_group_activity(group_id, 'member_removed', session['username'], member)
    
    return jsonify({'success': True})

@app.route('/api/groups/<int:group_id>/set_admin', methods=['POST'])
def set_group_admin(group_id):
    """Assign or remove admin rights for a group member (admin only)."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    admin = GroupMember.query.filter_by(group_id=group_id, username=session['username'], is_admin=True).first()
    if not admin:
        return jsonify({'error': 'Only admins can assign/remove admin rights'}), 403
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    member = data.get('username')
    make_admin = data.get('is_admin', True)
    gm = GroupMember.query.filter_by(group_id=group_id, username=member).first()
    if not gm:
        return jsonify({'error': 'User not in group'}), 400
    
    # Cannot demote the group creator
    if member == group.created_by and not make_admin:
        return jsonify({'error': 'Cannot remove admin status from group creator'}), 400
    
    gm.is_admin = make_admin
    
    # Update role to match admin status
    if make_admin and gm.role == 'member':
        gm.role = 'admin'
    elif not make_admin and gm.role == 'admin':
        gm.role = 'member'
    
    db.session.commit()
    
    # Log activity
    log_group_activity(group_id, 'admin_status_changed', session['username'], member, 
                      details={'is_admin': make_admin})
    
    return jsonify({'success': True, 'is_admin': gm.is_admin, 'role': gm.role})

@app.route('/groups/<int:group_id>/leave', methods=['POST'])
def leave_group(group_id):
    """Leave a group (if admin, must assign another admin if last admin)."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    gm = GroupMember.query.filter_by(group_id=group_id, username=session['username']).first()
    if not gm:
        return jsonify({'error': 'You are not a member of this group'}), 400
    if gm.is_admin:
        # Check if this is the last admin
        admin_count = GroupMember.query.filter_by(group_id=group_id, is_admin=True).count()
        if admin_count == 1:
            # Must assign another admin before leaving
            return jsonify({'error': 'Assign another admin before leaving'}), 400
    db.session.delete(gm)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/groups/<int:group_id>/update', methods=['POST'])
def update_group_info(group_id):
    """Update group name, description, icon, or admin_only setting (admin only)."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    admin = GroupMember.query.filter_by(group_id=group_id, username=session['username'], is_admin=True).first()
    if not admin:
        return jsonify({'error': 'Only admins can update group info'}), 403
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    
    # Store original values for activity logging
    original_name = group.name
    original_description = group.description
    original_admin_only = group.admin_only
    
    # Update fields if provided
    name = data.get('name')
    description = data.get('description')
    icon = data.get('icon')
    admin_only = data.get('admin_only')
    
    username = session['username']
    
    # Log activity for name change
    if name and name != original_name:
        group.name = name
        log_group_activity(group_id, 'group_name_changed', username, 
                          details={'old_name': original_name, 'new_name': name})
    
    # Log activity for description change
    if description is not None and description != original_description:
        if original_description is None or original_description == '':
            # Adding description
            log_group_activity(group_id, 'description_added', username, 
                              details={'description': description})
        elif description == '':
            # Removing description
            log_group_activity(group_id, 'description_removed', username, 
                              details={'old_description': original_description})
        else:
            # Changing description
            log_group_activity(group_id, 'description_changed', username, 
                              details={'old_description': original_description, 'new_description': description})
        group.description = description
    
    # Log activity for admin-only setting change
    if admin_only is not None and bool(admin_only) != original_admin_only:
        group.admin_only = bool(admin_only)
        log_group_activity(group_id, 'admin_only_changed', username, 
                          details={'admin_only': bool(admin_only)})
    
    if icon:
        group.icon = icon
    
    try:
        db.session.commit()
        return jsonify({
            'success': True,
            'name': group.name,
            'description': group.description,
            'admin_only': group.admin_only
        })
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': f'Database error: {str(e)}'}), 500

@app.route('/groups/<int:group_id>/set_members_admins', methods=['POST'])
def set_members_admins(group_id):
    """Update group members and admins (admin only)."""
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'success': False, 'error': 'Group not found'}), 404
    admin = GroupMember.query.filter_by(group_id=group_id, username=session['username'], is_admin=True).first()
    if not admin:
        return jsonify({'success': False, 'error': 'Only admins can update members/admins'}), 403
    data = request.get_json(force=True)
    members = data.get('members', [])
    admins = data.get('admins', [])
    # Remove all current members
    GroupMember.query.filter_by(group_id=group_id).delete()
    # Add new members and set admin status
    for m in set(members):
        is_admin = m in admins
        gm = GroupMember(group_id=group_id, username=m, is_admin=is_admin)
        db.session.add(gm)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/groups/<int:group_id>/admin_only', methods=['POST'])
def set_group_admin_only(group_id):
    """Set whether only admins can send messages in the group (admin only)."""
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'success': False, 'error': 'Group not found'}), 404
    admin = GroupMember.query.filter_by(group_id=group_id, username=session['username'], is_admin=True).first()
    if not admin:
        return jsonify({'success': False, 'error': 'Only admins can update this setting'}), 403
    data = request.get_json(force=True)
    admin_only = data.get('admin_only', False)
    group.admin_only = bool(admin_only)
    db.session.commit()
    return jsonify({'success': True, 'admin_only': group.admin_only})

@app.route('/api/groups/<int:group_id>/set_role', methods=['POST'])
def set_group_member_role(group_id):
    """Set a custom role for a group member (admin only)."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    admin = GroupMember.query.filter_by(group_id=group_id, username=session['username'], is_admin=True).first()
    if not admin:
        return jsonify({'error': 'Only admins can assign roles'}), 403
    
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    
    username = data.get('username')
    role = data.get('role', 'member')
    
    # Validate role
    valid_roles = ['member', 'moderator', 'admin']
    if role not in valid_roles:
        return jsonify({'error': f'Invalid role. Must be one of: {", ".join(valid_roles)}'}), 400
    
    # Find the member
    member = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    if not member:
        return jsonify({'error': 'User not in group'}), 400
    
    # Cannot change creator's role from admin
    if username == group.created_by and role != 'admin':
        return jsonify({'error': 'Cannot change role of group creator'}), 400
    
    # Update role
    member.role = role
    
    # Ensure admin status matches role
    if role == 'admin':
        member.is_admin = True
    elif role == 'moderator':
        # Moderators can have some admin privileges but not full admin status
        member.is_admin = False
    elif role == 'member':
        member.is_admin = False
    
    db.session.commit()
    return jsonify({'success': True, 'role': member.role, 'is_admin': member.is_admin})

@app.route('/api/groups/<int:group_id>/notification_preference', methods=['POST'])
def set_notification_preference(group_id):
    """Set notification preference for current user in a group."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    
    username = session['username']
    member = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    if not member:
        return jsonify({'error': 'Not a member of this group'}), 400
    
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    
    preference = data.get('preference', 'all')
    
    # Validate preference
    valid_preferences = ['all', 'mentions', 'none']
    if preference not in valid_preferences:
        return jsonify({'error': f'Invalid preference. Must be one of: {", ".join(valid_preferences)}'}), 400
    
    # Update preference
    member.notification_preference = preference
    db.session.commit()
    
    return jsonify({'success': True, 'preference': member.notification_preference})

@app.route('/api/groups/<int:group_id>/pin_message', methods=['POST'])
def pin_group_message(group_id):
    """Pin a message in a group (admin or moderator only)."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    
    username = session['username']
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    
    # Check if user is admin or moderator
    member = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    if not member or (not member.is_admin and member.role != 'moderator'):
        return jsonify({'error': 'Only admins and moderators can pin messages'}), 403
    
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    
    message_id = data.get('message_id')
    if not message_id:
        return jsonify({'error': 'Message ID required'}), 400
    
    # Check if message exists and belongs to this group
    message = Message.query.get(message_id)
    if not message:
        return jsonify({'error': 'Message not found'}), 404
    
    # Check if message belongs to this group
    group_room = f'group-{group_id}'
    if message.recipients != group_room:
        return jsonify({'error': 'Message does not belong to this group'}), 400
    
    # Check if message is already pinned
    existing_pin = PinnedMessage.query.filter_by(group_id=group_id, message_id=message_id).first()
    if existing_pin:
        return jsonify({'error': 'Message already pinned'}), 400
    
    # Pin the message
    pin = PinnedMessage(group_id=group_id, message_id=message_id, pinned_by=username)
    db.session.add(pin)
    db.session.commit()
    
    # Notify all clients in the group
    socketio.emit('message_pinned', {
        'group_id': group_id,
        'message_id': message_id,
        'pinned_by': username,
        'pinned_at': pin.pinned_at.isoformat()
    }, room=group_room)
    
    return jsonify({
        'success': True,
        'pin_id': pin.id,
        'message_id': message_id,
        'pinned_by': username,
        'pinned_at': pin.pinned_at.isoformat()
    })

@app.route('/api/groups/<int:group_id>/unpin_message', methods=['POST'])
def unpin_group_message(group_id):
    """Unpin a message in a group (admin or moderator only)."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    
    username = session['username']
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    
    # Check if user is admin or moderator
    member = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    if not member or (not member.is_admin and member.role != 'moderator'):
        return jsonify({'error': 'Only admins and moderators can unpin messages'}), 403
    
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Invalid JSON data'}), 400
    
    message_id = data.get('message_id')
    if not message_id:
        return jsonify({'error': 'Message ID required'}), 400
    
    # Find the pinned message
    pin = PinnedMessage.query.filter_by(group_id=group_id, message_id=message_id).first()
    if not pin:
        return jsonify({'error': 'Message not pinned'}), 404
    
    # Unpin the message
    db.session.delete(pin)
    db.session.commit()
    
    # Notify all clients in the group
    group_room = f'group-{group_id}'
    socketio.emit('message_unpinned', {
        'group_id': group_id,
        'message_id': message_id,
        'unpinned_by': username
    }, room=group_room)
    
    return jsonify({
        'success': True,
        'message_id': message_id,
        'unpinned_by': username
    })

@app.route('/api/groups/<int:group_id>/pinned_messages', methods=['GET'])
def get_pinned_messages(group_id):
    """Get all pinned messages for a group."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    
    username = session['username']
    
    # Check if user is a member of the group
    member = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    if not member:
        return jsonify({'error': 'Not a member of this group'}), 403
    
    # Get all pinned messages
    pins = PinnedMessage.query.filter_by(group_id=group_id).order_by(PinnedMessage.pinned_at.desc()).all()
    
    result = []
    for pin in pins:
        message = Message.query.get(pin.message_id)
        if message:
            result.append({
                'pin_id': pin.id,
                'message_id': pin.message_id,
                'message_content': message.content,
                'message_sender': message.sender,
                'message_timestamp': message.timestamp.isoformat() if message.timestamp else None,
                'pinned_by': pin.pinned_by,
                'pinned_at': pin.pinned_at.isoformat()
            })
    
    return jsonify(result)

@app.route('/groups/<int:group_id>/delete', methods=['POST'])
def delete_group(group_id):
    """Delete a group and all its members and messages (admin only)."""
    try:
        if 'username' not in session:
            return jsonify({'success': False, 'error': 'Not logged in'}), 401
        group = Group.query.get(group_id)
        if not group:
            return jsonify({'success': False, 'error': 'Group not found'}), 404
        admin = GroupMember.query.filter_by(group_id=group_id, username=session['username'], is_admin=True).first()
        if not admin:
            return jsonify({'success': False, 'error': 'Only admins can delete group'}), 403
        
        # Delete all pinned messages
        PinnedMessage.query.filter_by(group_id=group_id).delete()
        
        # Delete all group messages
        group_room = f'group-{group_id}'
        Message.query.filter_by(recipients=group_room).delete()
        # Delete all group members
        GroupMember.query.filter_by(group_id=group_id).delete()
        # Delete all group mutes
        GroupMute.query.filter_by(group_id=group_id).delete()
        # Delete the group itself
        db.session.delete(group)
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        import traceback
        print('Error deleting group:', e)
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500

# --- Group mute/unmute (per user) ---
class GroupMute(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=False)
    username = db.Column(db.String(80), db.ForeignKey('user.username'), nullable=False)
    __table_args__ = (db.UniqueConstraint('group_id', 'username', name='unique_group_mute'),)
    
    def __init__(self, group_id, username):
        self.group_id = group_id
        self.username = username
    
class PinnedMessage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=False)
    message_id = db.Column(db.Integer, db.ForeignKey('message.id'), nullable=False)
    pinned_by = db.Column(db.String(80), db.ForeignKey('user.username'), nullable=False)
    pinned_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    def __init__(self, group_id, message_id, pinned_by):
        self.group_id = group_id
        self.message_id = message_id
        self.pinned_by = pinned_by
        
class GroupActivity(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey('group.id'), nullable=False)
    action_type = db.Column(db.String(50), nullable=False)  # member_added, member_removed, role_changed, etc.
    actor = db.Column(db.String(80), db.ForeignKey('user.username'), nullable=False)  # Who performed the action
    target = db.Column(db.String(80), nullable=True)  # Target user or object of the action
    details = db.Column(db.Text, nullable=True)  # Additional details as JSON
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    
    def __init__(self, group_id, action_type, actor, target=None, details=None):
        self.group_id = group_id
        self.action_type = action_type
        self.actor = actor
        self.target = target
        self.details = details

@app.route('/groups/<int:group_id>/mute', methods=['POST'])
def mute_group(group_id):
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    if not GroupMute.query.filter_by(group_id=group_id, username=session['username']).first():
        mute = GroupMute(group_id=group_id, username=session['username'])
        db.session.add(mute)
        db.session.commit()
    return jsonify({'success': True, 'muted': True})

@app.route('/groups/<int:group_id>/unmute', methods=['POST'])
def unmute_group(group_id):
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    mute = GroupMute.query.filter_by(group_id=group_id, username=session['username']).first()
    if mute:
        db.session.delete(mute)
        db.session.commit()
    return jsonify({'success': True, 'muted': False})

@app.route('/api/groups/<int:group_id>/files', methods=['GET'])
def get_group_files(group_id):
    """Get all files shared in a group."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    
    username = session['username']
    
    # Check if user is a member of the group
    member = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    if not member:
        return jsonify({'error': 'Not a member of this group'}), 403
    
    file_type = request.args.get('type', 'all')
    
    # Get all messages with files in this group
    messages_with_files = Message.query.filter(
        Message.group_id == group_id,
        Message.file_id.isnot(None)
    ).order_by(Message.timestamp.desc()).all()
    
    files = []
    for message in messages_with_files:
        file = File.query.get(message.file_id)
        if file:
            # Determine file type for filtering
            file_extension = file.original_name.split('.')[-1].lower() if '.' in file.original_name else ''
            
            if file_extension in {'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'jfif'}:
                file_category = 'image'
            elif file_extension in {'mp4', 'webm', 'mov', 'avi', 'mkv'}:
                file_category = 'video'
            elif file_extension in {'mp3', 'wav', 'ogg'}:
                file_category = 'audio'
            elif file_extension in {'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'}:
                file_category = 'document'
            elif file_extension in {'zip', 'rar', '7z', 'tar'}:
                file_category = 'archive'
            else:
                file_category = 'other'
            
            # Apply file type filter
            if file_type != 'all' and file_category != file_type:
                continue
            
            files.append({
                'id': file.id,
                'file_name': file.original_name,
                'file_path': url_for('serve_file', file_id=file.id),
                'file_type': file_category,
                'file_extension': f'.{file_extension}',
                'uploader': file.uploader,
                'upload_date': file.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
                'message_id': message.id,
                'message_timestamp': message.timestamp.strftime('%Y-%m-%d %H:%M:%S')
            })
    
    return jsonify(files)

@app.route('/api/groups/<int:group_id>/activity', methods=['GET'])
def get_group_activity(group_id):
    """Get activity log for a group."""
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    
    username = session['username']
    
    # Check if user is a member of the group
    member = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    if not member:
        return jsonify({'error': 'Not a member of this group'}), 403
    
    # Get group activities
    activities = GroupActivity.query.filter_by(group_id=group_id).order_by(GroupActivity.timestamp.desc()).limit(100).all()
    
    result = []
    for activity in activities:
        # Parse JSON details if present
        details = None
        if activity.details:
            try:
                import json
                details = json.loads(activity.details)
            except:
                details = activity.details
        
        activity_data = {
            'id': activity.id,
            'action_type': activity.action_type,
            'actor': activity.actor,
            'target': activity.target,
            'timestamp': activity.timestamp.isoformat(),
            'details': details
        }
        result.append(activity_data)
    
    return jsonify(result)

# Update group info endpoint to include mute status for current user
@app.route('/groups/<int:group_id>/info', methods=['GET'])
def get_group_info_full(group_id):
    group = Group.query.get(group_id)
    if not group:
        return jsonify({'error': 'Group not found'}), 404
    members = GroupMember.query.filter_by(group_id=group_id).all()
    member_list = [{'username': m.username, 'is_admin': m.is_admin} for m in members]
    muted = False
    if 'username' in session:
        muted = GroupMute.query.filter_by(group_id=group_id, username=session['username']).first() is not None
    return jsonify({
        'id': group.id,
        'name': group.name,
        'icon': group.icon,
        'created_by': group.created_by,
        'created_at': group.created_at.strftime('%Y-%m-%d %H:%M'),
        'members': member_list,
        'muted': muted
    })

@app.route('/reset_password', methods=['GET', 'POST'])
def reset_password():
    """Step 1: User requests password reset (username only). Step 2: If approved, user can reset password."""
    error = None
    success = None
    show_reset_form = False
    username = request.args.get('username') or request.form.get('username')
    if request.method == 'POST':
        new_password = request.form.get('new_password')
        confirm_password = request.form.get('confirm_password')
        if new_password and confirm_password:
            # Check for approved reset request
            req = PasswordResetRequest.query.filter_by(username=username, status='approved').first()
            user = User.query.filter_by(username=username).first()
            if not user:
                error = 'User not found.'
            elif not req:
                error = 'Your reset request is not approved yet.'
            elif new_password != confirm_password:
                error = 'Passwords do not match.'
                show_reset_form = True
            else:
                user.password = cipher_suite.encrypt(new_password.encode())
                # Mark the reset request as used instead of deleting
                req.status = 'used'
                req.approved_at = datetime.utcnow()
                db.session.commit()
                success = 'Password reset successful. You can now log in.'
        else:
            # Step 1: Create/reset request
            if not username:
                error = 'Username required.'
            else:
                user = User.query.filter_by(username=username).first()
                if not user:
                    error = 'User not found.'
                else:
                    existing = PasswordResetRequest.query.filter(
                        getattr(PasswordResetRequest, "username") == username,
                        getattr(PasswordResetRequest, "status").in_(['pending', 'approved'])
                    ).first()
                    if existing:
                        if existing.status == 'pending':
                            error = 'A reset request is already pending approval.'
                        elif existing.status == 'approved':
                            error = 'Your reset request is already approved. <a href="/reset_password?username={}">Click here to set a new password.</a>'.format(username)
                            show_reset_form = False
                        else:
                            error = 'A reset request already exists.'
                    else:
                        req = PasswordResetRequest(username=username)
                        db.session.add(req)
                        db.session.commit()
                        # Real-time: notify all admins for password reset request
                        socketio.emit('new_password_reset_request', {'username': username})
                        success = 'Reset request submitted. Wait for admin approval.'
    # If GET with ?username=... and approved, show reset form
    if username:
        req = PasswordResetRequest.query.filter_by(username=username, status='approved').first()
        if req:
            show_reset_form = True
    return render_template('reset_password.html', error=error, success=success, show_reset_form=show_reset_form, username=username)

@app.route('/test-notifications')
def test_notifications():
    """Test page for real-time notifications - Admin only for security."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    return send_from_directory('.', 'test_notifications.html')

@app.route('/silent-test')
def silent_test():
    """Silent real-time updates test page - Admin only for security."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    return send_from_directory('.', 'silent_realtime_test.html')

@app.route('/demo-deletion')
def demo_deletion():
    """Complete message deletion demo page - Admin only for security."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    return send_from_directory('.', 'demo_complete_deletion.html')

@app.route('/test-sidebar')
def test_sidebar():
    """Sidebar notifications test page - Admin only for security."""
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    return send_from_directory('.', 'test_sidebar_notifications.html')

@app.route('/register')
def register():
    """Admin-only route to view system data (passwords are NOT exposed)."""
    # SECURITY: Only allow admin access
    if 'username' not in session or not session.get('is_admin'):
        return redirect(url_for('login'))
    
    users = User.query.all()
    messages = Message.query.all()
    files = File.query.all()
 
    # Format data (NO PASSWORD EXPOSURE)
    user_data = [
        {
            'id': user.id,
            'username': user.username,
            'password_set': bool(user.password),  # Only show if password exists
            'online': user.online,
            'is_admin': user.is_admin,
            'created_by': user.created_by
        }
        for user in users
    ]
 
    message_data = [
        {
            'id': message.id,
            'sender': message.sender,
            'recipients': message.recipients,
            'content': decrypt_message(message.content) if message.content else '',
            'timestamp': message.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
            'status': message.status,
            'reply_to': message.reply_to,
            'reactions': message.reactions
        }
        for message in messages
    ]
 
    file_data = [
        {
            'id': file.id,
            'filename': file.filename,
            'original_name': file.original_name,
            'uploader': file.uploader,
            'timestamp': file.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
            'mimetype': file.mimetype
        }
        for file in files
    ]
 
    return render_template('register.html', users=user_data, messages=message_data, files=file_data)
 
 


# --- SocketIO Events for Real-Time Features ---
@socketio.on('connect')
def handle_connect():
    """Handle new WebSocket connection and update online users."""
    username = session.get('username')
    if username:
        online_users.add(username)
        user = User.query.filter_by(username=username).first()
        if user:
            user.online = True
            db.session.commit()
        emit('user_list', list(online_users), broadcast=True)

@socketio.on('disconnect')
def handle_disconnect():
    """Handle WebSocket disconnect and update online users."""
    username = session.get('username')
    if username:
        online_users.discard(username)
        user = User.query.filter_by(username=username).first()
        if user:
            user.online = False
            db.session.commit()

@socketio.on('join')
def on_join(data):
    """Join a private or group chat room."""
    room = data.get('room')
    join_room(room)

@socketio.on('leave')
def on_leave(data):
    """Leave a private or group chat room."""
    room = data.get('room')
    leave_room(room)

@socketio.on('send_message')
def handle_message(data):
    """Handle sending messages (public, private, group) and broadcast to recipients."""
    import json
    sender = session.get('username')
    recipients = data.get('recipients', 'all')
    content = data.get('content', '')
    encrypted_content = encrypt_message(content) if content else None
    file_id = data.get('file_id')
    reply_to = data.get('reply_to')  # New: replied message id

    group_id = None
    # --- Admin-only group message enforcement ---
    if recipients.startswith('group-'):
        try:
            group_id = int(recipients.split('-')[1])
            group = Group.query.get(group_id)
            if group and group.admin_only:
                gm = GroupMember.query.filter_by(group_id=group_id, username=sender).first()
                if not gm or not gm.is_admin:
                    emit('group_admin_only_error', {'error': 'Only admins can send messages in this group.'}, to=sender)
                    return  # Do not process message
        except Exception as e:
            emit('group_admin_only_error', {'error': 'Group admin check failed.'}, to=sender)
            return

    # Always set group_id for group messages
    msg = Message(sender=sender, recipients=recipients, content=encrypted_content, file_id=file_id, status='sent', reply_to=reply_to, group_id=group_id)
    db.session.add(msg)
    db.session.commit()
    # Fetch reply message if any
    reply_msg = None
    if reply_to:
        reply = Message.query.get(reply_to)
        if reply:
            reply_msg = {
                'id': reply.id,
                'sender': reply.sender,
                'content': decrypt_message(reply.content) if reply.content else '',
                'timestamp': reply.timestamp.strftime('%Y-%m-%dT%H:%M:%SZ') if reply.timestamp else None
            }
    msg_data = {
        'id': msg.id,
        'sender': sender,
        'recipients': recipients,
        'content': decrypt_message(msg.content) if msg.content else '',
        'timestamp': msg.timestamp.strftime('%Y-%m-%dT%H:%M:%SZ') if msg.timestamp else None,
        'file': None,
        'status': msg.status,
        'reply_to': reply_msg,
        'reactions': json.loads(msg.reactions) if msg.reactions else {},
        'group_id': msg.group_id
    }
    if file_id:
        f = File.query.get(file_id)
        if f:
            msg_data['file'] = {
                'filename': f.filename,
                'original_name': f.original_name,
                'mimetype': f.mimetype
            }
    if recipients == 'all':
        emit('receive_message', msg_data, broadcast=True)
    elif recipients.startswith('group-'):
        emit('receive_message', msg_data, to=recipients)
    else:
        for r in recipients.split(','):
            emit('receive_message', msg_data, to=r.strip())
        emit('receive_message', msg_data, to=sender)

# New: React to a message
@socketio.on('react_message')
def handle_react_message(data):
    import json
    msg_id = data.get('msg_id')
    emoji = data.get('emoji')
    username = session.get('username')
    msg = Message.query.get(msg_id)
    if msg and emoji and username:
        reactions = json.loads(msg.reactions) if msg.reactions else {}
        if emoji not in reactions:
            reactions[emoji] = []
        if username not in reactions[emoji]:
            reactions[emoji].append(username)
        msg.reactions = json.dumps(reactions)
        db.session.commit()
        emit('update_reactions', {'msg_id': msg_id, 'reactions': reactions}, broadcast=True)

# New: Remove reaction
@socketio.on('remove_reaction')
def handle_remove_reaction(data):
    import json
    msg_id = data.get('msg_id')
    emoji = data.get('emoji')
    username = session.get('username')
    msg = Message.query.get(msg_id)
    if msg and emoji and username:
        reactions = json.loads(msg.reactions) if msg.reactions else {}
        if emoji in reactions and username in reactions[emoji]:
            reactions[emoji].remove(username)
            if not reactions[emoji]:
                del reactions[emoji]
            msg.reactions = json.dumps(reactions)
            db.session.commit()
            emit('update_reactions', {'msg_id': msg_id, 'reactions': reactions}, broadcast=True)

@socketio.on('message_read')
def handle_message_read(data):
    """Mark a message as read and notify the sender."""
    msg_id = data.get('msg_id')
    username = session.get('username')
    msg = Message.query.get(msg_id)
    if msg and username and (username in msg.recipients.split(',') or msg.recipients == username):
        msg.status = 'read'
        db.session.commit()
        # Notify the sender
        emit('message_read', {'msg_id': msg_id}, to=msg.sender)

@socketio.on('typing')
def handle_typing(data):
    to = data.get('to')
    sender = session.get('username')
    if to and sender:
        if to.startswith('group-'):
            emit('show_typing', {'from': sender, 'room': to}, to=to, include_self=False)
        else:
            emit('show_typing', {'from': sender}, to=to)

@socketio.on('stop_typing')
def handle_stop_typing(data):
    to = data.get('to')
    sender = session.get('username')
    if to and sender:
        if to.startswith('group-'):
            emit('hide_typing', {'from': sender, 'room': to}, to=to, include_self=False)
        else:
            emit('hide_typing', {'from': sender}, to=to)

@socketio.on('group_deleted')
def handle_group_deleted(data):
    group_id = data.get('group_id')
    emit('group_deleted', {'group_id': group_id}, broadcast=True)

@socketio.on('group_read')
def handle_group_read(data):
    group_id = data.get('group_id')
    if group_id:
        emit('group_read', {'group_id': group_id}, broadcast=True)

@app.route('/clear_chat', methods=['POST'])
def clear_chat():
    """Clear chat history only for the current user (private chat)."""
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    username = session['username']
    other_user = request.form.get('user')
    if not other_user:
        return jsonify({'success': False, 'error': 'No user specified'}), 400

    from sqlalchemy import or_, and_
    messages = Message.query.filter(
        or_(
            and_(Message.sender == username, Message.recipients.like(f"%{other_user}%")),
            and_(Message.sender == other_user, Message.recipients.like(f"%{username}%"))
        ),
        Message.group_id.is_(None)
    ).all()

    # Mark all these messages as hidden for this user (soft clear)
    from sqlalchemy.exc import IntegrityError
    deleted_msg_ids = []
    for m in messages:
        try:
            db.session.add(HiddenMessage(msg_id=m.id, username=username))
            deleted_msg_ids.append(m.id)
        except IntegrityError:
            db.session.rollback()
            # Already hidden
    db.session.commit()

    # Notify only this user about clearing
    clear_data = {
        'cleared_by': username,
        'other_user': other_user,
        'deleted_msg_ids': deleted_msg_ids,
        'chat_type': 'private'
    }
    socketio.emit('chat_cleared', clear_data, to=username)

    return jsonify({'success': True})

@app.route('/clear_group_chat', methods=['POST'])
def clear_group_chat():
    """Clear group chat history only for the current user (soft clear)."""
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    
    username = session['username']
    group_id = request.form.get('group_id')
    
    if not group_id:
        return jsonify({'success': False, 'error': 'No group specified'}), 400
    
    # Check if user is a member of the group
    group_member = GroupMember.query.filter_by(group_id=group_id, username=username).first()
    if not group_member:
        return jsonify({'success': False, 'error': 'Not a group member'}), 403
    
    # Get all group messages
    messages = Message.query.filter_by(group_id=group_id).all()
    deleted_msg_ids = []
    
    # Mark hidden for this user instead of deleting
    from sqlalchemy.exc import IntegrityError
    for m in messages:
        try:
            db.session.add(HiddenMessage(msg_id=m.id, username=username))
            deleted_msg_ids.append(m.id)
        except IntegrityError:
            db.session.rollback()
            # Already hidden
    db.session.commit()
    
    # Notify only this user about chat clearing
    clear_data = {
        'cleared_by': username,
        'group_id': group_id,
        'deleted_msg_ids': deleted_msg_ids,
        'chat_type': 'group'
    }
    
    socketio.emit('chat_cleared', clear_data, to=username)
    
    return jsonify({'success': True})

@app.route('/unread_counts')
def unread_counts():
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    username = session['username']
    # Count unread private messages per user
    from collections import defaultdict
    unread_chats = 0
    individual_badges = defaultdict(int)
    hidden_subq = db.session.query(HiddenMessage.msg_id).filter(HiddenMessage.username == username)
    private_msgs = Message.query.filter(
        Message.recipients.like(f'%{username}%'),
        Message.status != 'read',
        Message.group_id.is_(None),
        ~Message.id.in_(hidden_subq)
    ).all()
    for msg in private_msgs:
        # Find the sender (other user)
        other = msg.sender if msg.sender != username else msg.recipients
        individual_badges[other] += 1
        unread_chats += 1
    # Count unread group messages per group
    group_ids = [gm.group_id for gm in GroupMember.query.filter_by(username=username).all()]
    unread_groups = 0
    group_badges = defaultdict(int)
    if group_ids:
        hidden_subq = db.session.query(HiddenMessage.msg_id).filter(HiddenMessage.username == username)
        group_msgs = Message.query.filter(
            Message.group_id.in_(group_ids),
            Message.status != 'read',
            Message.sender != username,
            ~Message.id.in_(hidden_subq)
        ).all()
        for msg in group_msgs:
            group_badges[str(msg.group_id)] += 1
            unread_groups += 1
    return jsonify({
        'chats': unread_chats,
        'groups': unread_groups,
        'individual_badges': dict(individual_badges),
        'group_badges': dict(group_badges)
    })

# --- Mark messages as read for a chat or group ---
@app.route('/mark_read', methods=['POST'])
def mark_read():
    if 'username' not in session:
        return jsonify({'success': False, 'error': 'Not logged in'}), 401
    username = session['username']
    chat_user = request.form.get('user')
    group_id = request.form.get('group_id')
    from sqlalchemy import or_, and_
    count = 0
    if chat_user:
        # Mark all private messages as read
        messages = Message.query.filter(
            or_(
                and_(Message.sender == chat_user, Message.recipients.like(f'%{username}%')),
                and_(Message.sender == username, Message.recipients.like(f'%{chat_user}%'))
            ),
            Message.status != 'read',
            Message.group_id.is_(None)
        ).all()
        for m in messages:
            m.status = 'read'
            count += 1
        db.session.commit()
    elif group_id:
        # Mark all group messages as read
        messages = Message.query.filter(
            Message.group_id == group_id,
            Message.status != 'read',
            Message.sender != username
        ).all()
        for m in messages:
            m.status = 'read'
            count += 1
        db.session.commit()
    else:
        return jsonify({'success': False, 'error': 'No chat or group specified'}), 400
    return jsonify({'success': True, 'marked': count})

@app.route('/files_data')
def files_data():
    if 'username' not in session:
        return jsonify({'error': 'Not logged in'}), 401
    username = session['username']
    is_admin = session.get('is_admin', False)
    files = []
    if is_admin:
        # Admin: show all files
        all_files = File.query.order_by(File.timestamp.desc()).all()
        for file in all_files:
            files.append({
                'file_id': file.id,
                'filename': file.filename,
                'original_name': file.original_name,
                'mimetype': file.mimetype,
                'uploader': file.uploader,
                'timestamp': file.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
                'download_url': url_for('uploaded_file', filename=file.filename)
            })
    else:
        # User: show files where user is sender, recipient, or uploader
        # 1. Files attached to messages where user is sender or recipient
        messages = Message.query.filter(
            or_(
                Message.sender == username,
                Message.recipients.like(f'%{username}%')
            ),
            Message.file_id != None
        ).order_by(Message.timestamp.desc()).all()
        file_ids = set()
        for msg in messages:
            if msg.file_id:
                file_ids.add(msg.file_id)
        # 2. Files uploaded by the user (even if not attached to a message)
        user_files = File.query.filter_by(uploader=username).all()
        for file in user_files:
            file_ids.add(file.id)
        # Now fetch all unique files
        for file_id in file_ids:
            file = File.query.get(file_id)
            if not file:
                continue
            files.append({
                'file_id': file.id,
                'filename': file.filename,
                'original_name': file.original_name,
                'mimetype': file.mimetype,
                'uploader': file.uploader,
                'timestamp': file.timestamp.strftime('%Y-%m-%d %H:%M:%S'),
                'download_url': url_for('uploaded_file', filename=file.filename)
            })
    print(f"[DEBUG] /files_data for user '{username}' (admin={is_admin}): {files}")
    return jsonify({'files': files})

@app.route('/files')
def files():
    if 'username' not in session:
        return redirect(url_for('login'))
    return render_template('dashboard.html', username=session['username'], host_ip=get_host_ip(), active_section='files')

# --- Main Entrypoint ---
if __name__ == '__main__':
    import signal
    import sys
    
    def signal_handler(sig, frame):
        print('\nShutting down LANChat server...')
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    # Ensure upload directory exists
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    with app.app_context():
        db.create_all()
        # --- Add default admins only if they don't exist ---
        admin_list: list[dict[str, str]] = [
            {'username': 'Vicky', 'password': 'vickyadmin'},
            {'username': 'Ajinkya', 'password': 'ajinkyaadmin'}
        ]
        for admin in admin_list:
            # Check if admin already exists
            existing_user = User.query.filter_by(username=admin['username']).first()
            if not existing_user:
                user = User(
                    username=admin['username'],
                    password=cipher_suite.encrypt(admin['password'].encode()).decode(),  # Store as string
                    is_admin=True,
                    created_by='system'
                )
                db.session.add(user)
                print(f"Created default admin: {admin['username']}")
            else:
                print(f"Admin {admin['username']} already exists, skipping...")
        db.session.commit()

def get_private_ip():
    try:
        # Get all addresses associated with the host
        hostname = socket.gethostname()
        addresses = socket.getaddrinfo(hostname, None)
        for addr in addresses:
            family, _, _, _, sockaddr = addr
            if family == socket.AF_INET:
                ip = sockaddr[0]
                # Skip loopback
                if isinstance(ip, str) and not ip.startswith("127."):
                    return ip
        # Fallback: try to gethostbyname
        ip = socket.gethostbyname(hostname)
        if isinstance(ip, str) and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    return "Unavailable"

def get_localhost_ip():
    return "127.0.0.1"

def find_available_port(start_port=5000, max_attempts=10):
    """Find an available port starting from start_port"""
    import socket
    for port in range(start_port, start_port + max_attempts):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('localhost', port))
                return port
        except OSError:
            continue
    return start_port  # Fallback to original port


# Find available port
port = find_available_port(5000)

# Print both
print(f"LANChatShare server running at:")
print(f"  → Private IP:   http://{get_private_ip()}:{port}")
print(f"  → Localhost IP: http://{get_localhost_ip()}:{port}")

socketio.run(app, host='0.0.0.0', port=port, debug=True)
