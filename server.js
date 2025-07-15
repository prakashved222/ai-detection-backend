const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/smartface-attendance', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

// User Schema
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  employeeId: { type: String, required: true, unique: true },
  department: { type: String, required: true },
  role: { type: String, required: true },
  faceRegistered: { type: Boolean, default: false },
  imageUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Attendance Schema
const attendanceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  employeeId: { type: String, required: true },
  clockIn: { type: Date },
  clockOut: { type: Date },
  date: { type: String, required: true }, // YYYY-MM-DD format
  status: { type: String, enum: ['present', 'absent', 'partial'], default: 'present' },
  workingHours: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

// Face Recognition Service URL
const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://localhost:5000';

// Helper function to call face recognition service
const callFaceService = async (endpoint, data) => {
  try {
    const response = await axios.post(`${FACE_SERVICE_URL}${endpoint}`, data);
    return response.data;
  } catch (error) {
    console.error('Face service error:', error.message);
    throw new Error('Face recognition service unavailable');
  }
};

// Helper function to check if current time is within allowed window
function isWithinTimeWindow(now, startHour, startMinute, endHour, endMinute) {
  const start = new Date(now);
  start.setHours(startHour, startMinute, 0, 0);
  const end = new Date(now);
  end.setHours(endHour, endMinute, 0, 0);
  return now >= start && now <= end;
}

// Simple admin credentials (can be moved to DB later)
const ADMIN_USERNAME = 'adeeb';
const ADMIN_PASSWORD = '123';

// Admin login route
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return res.json({ success: true, token });
  }
  res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// Admin auth middleware
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.username !== ADMIN_USERNAME) throw new Error();
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

// Routes

// Health check
app.get('/api/health', async (req, res) => {
  try {
    // Check face service health
    const faceServiceHealth = await axios.get(`${FACE_SERVICE_URL}/health`);
    res.json({
      status: 'healthy',
      database: 'connected',
      faceService: faceServiceHealth.data
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'connected',
      faceService: 'unavailable'
    });
  }
});

// Register user face
app.post('/api/users/register-face', async (req, res) => {
  try {
    const { userId, image } = req.body;
    
    if (!userId || !image) {
      return res.status(400).json({ success: false, message: 'User ID and image are required' });
    }
    
    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Call face registration service
    const result = await callFaceService('/register', {
      user_id: userId,
      user_name: user.name,
      image: image
    });
    
    if (result.success) {
      // Update user face registration status
      user.faceRegistered = true;
      user.updatedAt = new Date();
      await user.save();
    }
    
    res.json(result);
    
  } catch (error) {
    console.error('Face registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Recognize face for attendance
app.post('/api/attendance/recognize', async (req, res) => {
  try {
    const { image } = req.body;
    
    if (!image) {
      return res.status(400).json({ success: false, message: 'Image is required' });
    }
    
    // Call face recognition service
    const result = await callFaceService('/recognize', { image });
    
    if (result.success) {
      // Find user
      const user = await User.findById(result.user_id);
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found in database' });
      }
      
      // Return user info for attendance marking
      res.json({
        success: true,
        user: {
          id: user._id,
          name: user.name,
          employeeId: user.employeeId,
          department: user.department
        },
        confidence: result.confidence
      });
    } else {
      res.json(result);
    }
    
  } catch (error) {
    console.error('Face recognition error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Clock in/out
app.post('/api/attendance/clock', async (req, res) => {
  try {
    const { userId, action } = req.body; // action: 'in' or 'out'
    if (!userId || !action) {
      return res.status(400).json({ success: false, message: 'User ID and action are required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // Time windows
    const IN_START = { hour: 9, minute: 30 };
    const IN_END = { hour: 9, minute: 45 };
    const OUT_START = { hour: 22, minute: 0 };    // 10:00 PM
    const OUT_END = { hour: 22, minute: 30 };   // 10:30 PM

    // Find or create attendance record for today
    let attendance = await Attendance.findOne({ userId, date: today });

    if (action === 'in') {
      if (!isWithinTimeWindow(now, IN_START.hour, IN_START.minute, IN_END.hour, IN_END.minute)) {
        return res.status(400).json({ success: false, message: 'Clock IN only allowed between 9:30 AM and 9:45 AM' });
      }
      if (attendance && attendance.clockIn) {
        return res.status(400).json({ success: false, message: 'Already clocked in today' });
      }
      if (!attendance) {
        attendance = new Attendance({
          userId,
          employeeId: user.employeeId,
          date: today,
          clockIn: now,
        });
      } else {
        attendance.clockIn = now;
      }
      await attendance.save();
      return res.json({ success: true, message: `Clock in successful for ${user.name}`, attendance });
    }

    if (action === 'out') {
      if (!isWithinTimeWindow(now, OUT_START.hour, OUT_START.minute, OUT_END.hour, OUT_END.minute)) {
        return res.status(400).json({ success: false, message: 'Clock OUT only allowed between 10:00 PM and 10:30 PM' });
      }
      if (!attendance || !attendance.clockIn) {
        return res.status(400).json({ success: false, message: 'Must clock in first' });
      }
      if (attendance.clockOut) {
        return res.status(400).json({ success: false, message: 'Already clocked out today' });
      }
      attendance.clockOut = now;
      // Calculate working hours
      const workingHours = (attendance.clockOut - attendance.clockIn) / (1000 * 60 * 60);
      attendance.workingHours = Math.round(workingHours * 100) / 100;
      await attendance.save();
      return res.json({
        success: true,
        message: `Clock out successful for ${user.name}`,
        attendance,
        workingHours: attendance.workingHours,
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid action' });
  } catch (error) {
    console.error('Clock in/out error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get a single user by ID
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Create a new user
app.post('/api/users', async (req, res) => {
  try {
    const { name, email, employeeId, department, role } = req.body;
    if (!name || !email || !employeeId || !department || !role) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    const user = new User({ name, email, employeeId, department, role });
    await user.save();
    res.status(201).json({ success: true, user });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Email or Employee ID already exists' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update a user
app.put('/api/users/:id', async (req, res) => {
  try {
    const { name, email, employeeId, department, role } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, email, employeeId, department, role, updatedAt: new Date() },
      { new: true, runValidators: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete a user
app.delete('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all attendance logs (with optional filters)
app.get('/api/attendance', async (req, res) => {
  try {
    const { userId, date, from, to } = req.query;
    let filter = {};
    if (userId) filter.userId = userId;
    if (date) filter.date = date;
    if (from && to) filter.date = { $gte: from, $lte: to };

    const logs = await Attendance.find(filter)
      .populate('userId', 'name employeeId department')
      .sort({ date: -1, clockIn: -1 });

    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get attendance logs for a specific user
app.get('/api/attendance/user/:userId', async (req, res) => {
  try {
    const logs = await Attendance.find({ userId: req.params.userId })
      .sort({ date: -1, clockIn: -1 });
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get attendance for a specific date
app.get('/api/attendance/date/:date', async (req, res) => {
  try {
    const logs = await Attendance.find({ date: req.params.date })
      .populate('userId', 'name employeeId department')
      .sort({ clockIn: -1 });
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin-only attendance logs route
app.get('/admin/attendance', adminAuth, async (req, res) => {
  try {
    const logs = await Attendance.find()
      .populate('userId', 'name employeeId department')
      .sort({ date: -1, clockIn: -1 });
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Default route
app.get('/', (req, res) => {
  res.json({
    message: 'SmartFace Attendance System API',
    status: 'running',
    version: '1.0.0'
  });
});

// Connect to database and start server
connectDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Face Recognition Service: ${FACE_SERVICE_URL}`);
  });
});