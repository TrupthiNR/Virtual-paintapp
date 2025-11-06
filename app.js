// Configuration
const CONFIG = {
    canvas: {
        width: 1280,
        height: 720,
        backgroundColor: 'rgba(255,255,255,1)'
    },
    colorPalette: [
        { name: 'Red', rgb: [255, 0, 0], position: [50, 50, 150, 150] },
        { name: 'Green', rgb: [0, 255, 0], position: [200, 50, 300, 150] },
        { name: 'Blue', rgb: [0, 0, 255], position: [350, 50, 450, 150] },
        { name: 'Yellow', rgb: [255, 255, 0], position: [500, 50, 600, 150] }
    ],
    brush: {
        defaultThickness: 10,
        minThickness: 2,
        maxThickness: 50,
        eraserThickness: 40
    },
    gestureThresholds: {
        fingerDetectionThreshold: 0.5,
        handConfidenceMin: 0.7,
        shapeAreaMin: 2000,
        shapeDetectionAccuracy: 0.04
    },
    performance: {
        targetFPS: 30,
        detectionInterval: 100
    }
};

// Application State
const state = {
    detector: null,
    video: null,
    drawingCanvas: null,
    drawingCtx: null,
    overlayCanvas: null,
    overlayCtx: null,
    currentColor: [255, 0, 0],
    brushSize: CONFIG.brush.defaultThickness,
    eraserSize: CONFIG.brush.eraserThickness,
    previousPosition: { x: 0, y: 0 },
    isDrawing: false,
    currentMode: 'idle',
    history: [],
    historyIndex: -1,
    fps: 0,
    lastFrameTime: Date.now(),
    frameCount: 0,
    detectedShapes: []
};

// Initialize application
async function init() {
    try {
        // Get DOM elements
        state.video = document.getElementById('videoElement');
        state.drawingCanvas = document.getElementById('drawingCanvas');
        state.drawingCtx = state.drawingCanvas.getContext('2d');
        state.overlayCanvas = document.getElementById('overlayCanvas');
        state.overlayCtx = state.overlayCanvas.getContext('2d');

        // Set canvas sizes
        const container = document.querySelector('.canvas-container');
        const rect = container.getBoundingClientRect();
        
        [state.drawingCanvas, state.overlayCanvas].forEach(canvas => {
            canvas.width = rect.width;
            canvas.height = rect.height;
        });

        // Initialize webcam
        await initWebcam();

        // Initialize hand detection
        await initHandDetection();

        // Setup event listeners
        setupEventListeners();

        // Hide loading overlay
        document.getElementById('loadingOverlay').style.display = 'none';

        // Start detection loop
        detectHands();

        // Start FPS counter
        updateFPS();
    } catch (error) {
        console.error('Initialization error:', error);
        showError('Failed to initialize application: ' + error.message);
    }
}

// Initialize webcam
async function initWebcam() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            }
        });
        state.video.srcObject = stream;
        return new Promise((resolve) => {
            state.video.onloadedmetadata = () => {
                resolve();
            };
        });
    } catch (error) {
        throw new Error('Camera access denied. Please allow camera permissions.');
    }
}

// Initialize hand detection model
async function initHandDetection() {
    try {
        const model = handPoseDetection.SupportedModels.MediaPipeHands;
        const detectorConfig = {
            runtime: 'mediapipe',
            solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands',
            maxHands: 1,
            modelType: 'full'
        };
        state.detector = await handPoseDetection.createDetector(model, detectorConfig);
    } catch (error) {
        throw new Error('Failed to load hand detection model: ' + error.message);
    }
}

// Main hand detection loop
async function detectHands() {
    if (!state.detector || !state.video) return;

    try {
        const hands = await state.detector.estimateHands(state.video);
        
        // Clear overlay
        state.overlayCtx.clearRect(0, 0, state.overlayCanvas.width, state.overlayCanvas.height);

        if (hands.length > 0) {
            const hand = hands[0];
            processHand(hand);
            drawHandLandmarks(hand);
            
            // Update confidence
            const confidence = Math.round(hand.score * 100);
            document.getElementById('confidence').textContent = confidence + '%';
        } else {
            state.previousPosition = { x: 0, y: 0 };
            state.currentMode = 'idle';
            updateModeIndicator('Idle');
        }

        // Detect shapes
        detectShapes();

        state.frameCount++;
    } catch (error) {
        console.error('Detection error:', error);
    }

    requestAnimationFrame(detectHands);
}

// Process hand gestures
function processHand(hand) {
    const landmarks = hand.keypoints;
    const videoWidth = state.video.videoWidth;
    const videoHeight = state.video.videoHeight;
    const canvasWidth = state.drawingCanvas.width;
    const canvasHeight = state.drawingCanvas.height;

    // Scale landmarks to canvas size
    const scaledLandmarks = landmarks.map(lm => ({
        x: (1 - lm.x / videoWidth) * canvasWidth, // Mirror horizontally
        y: (lm.y / videoHeight) * canvasHeight
    }));

    // Detect fingers up
    const fingersUp = detectFingers(scaledLandmarks);
    const totalFingers = fingersUp.reduce((sum, val) => sum + val, 0);

    // Get finger tip positions
    const indexTip = scaledLandmarks[8];
    const thumbTip = scaledLandmarks[4];

    // Check for color palette selection
    if (totalFingers === 1 && fingersUp[1] === 1) {
        checkColorPaletteSelection(indexTip);
    }

    // Clear canvas (5 fingers up)
    if (totalFingers === 5) {
        clearCanvas();
        state.currentMode = 'clear';
        updateModeIndicator('Canvas Cleared', 'color-select');
        state.previousPosition = { x: 0, y: 0 };
        return;
    }

    // Eraser mode (thumb only)
    if (fingersUp[0] === 1 && totalFingers === 1) {
        state.currentMode = 'eraser';
        updateModeIndicator('Eraser Mode', 'eraser');
        drawOnCanvas(thumbTip, true);
        return;
    }

    // Drawing mode (index finger only)
    if (fingersUp[1] === 1 && totalFingers === 1) {
        state.currentMode = 'drawing';
        updateModeIndicator('Drawing Mode', 'drawing');
        drawOnCanvas(indexTip, false);
        return;
    }

    // Reset previous position if no active gesture
    state.previousPosition = { x: 0, y: 0 };
    if (state.currentMode !== 'color-select') {
        state.currentMode = 'idle';
        updateModeIndicator('Idle');
    }
}

// Detect which fingers are up
function detectFingers(landmarks) {
    const fingers = [0, 0, 0, 0, 0]; // thumb, index, middle, ring, pinky
    const tipIds = [4, 8, 12, 16, 20];
    const pipIds = [3, 6, 10, 14, 18];

    // Thumb (check x-axis for horizontal detection)
    if (landmarks[tipIds[0]].x < landmarks[pipIds[0]].x) {
        fingers[0] = 1;
    }

    // Other fingers (check y-axis)
    for (let i = 1; i < 5; i++) {
        if (landmarks[tipIds[i]].y < landmarks[pipIds[i]].y - 20) {
            fingers[i] = 1;
        }
    }

    return fingers;
}

// Draw on canvas
function drawOnCanvas(position, isEraser) {
    if (state.previousPosition.x === 0 && state.previousPosition.y === 0) {
        state.previousPosition = position;
        return;
    }

    state.drawingCtx.lineWidth = isEraser ? state.eraserSize : state.brushSize;
    state.drawingCtx.lineCap = 'round';
    state.drawingCtx.lineJoin = 'round';

    if (isEraser) {
        state.drawingCtx.globalCompositeOperation = 'destination-out';
    } else {
        state.drawingCtx.globalCompositeOperation = 'source-over';
        const [r, g, b] = state.currentColor;
        state.drawingCtx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
    }

    state.drawingCtx.beginPath();
    state.drawingCtx.moveTo(state.previousPosition.x, state.previousPosition.y);
    state.drawingCtx.lineTo(position.x, position.y);
    state.drawingCtx.stroke();

    state.previousPosition = position;
    state.isDrawing = true;
}

// Check color palette selection
function checkColorPaletteSelection(position) {
    const scaleX = state.drawingCanvas.width / 1280;
    const scaleY = state.drawingCanvas.height / 720;

    for (const color of CONFIG.colorPalette) {
        const [x1, y1, x2, y2] = color.position;
        const scaledX1 = x1 * scaleX;
        const scaledY1 = y1 * scaleY;
        const scaledX2 = x2 * scaleX;
        const scaledY2 = y2 * scaleY;

        if (position.x > scaledX1 && position.x < scaledX2 &&
            position.y > scaledY1 && position.y < scaledY2) {
            state.currentColor = color.rgb;
            state.currentMode = 'color-select';
            updateModeIndicator(`Color: ${color.name}`, 'color-select');
            
            // Update UI
            document.querySelectorAll('.color-btn').forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.color === color.name.toLowerCase()) {
                    btn.classList.add('active');
                }
            });
            
            return;
        }
    }
}

// Draw hand landmarks
function drawHandLandmarks(hand) {
    const ctx = state.overlayCtx;
    const videoWidth = state.video.videoWidth;
    const videoHeight = state.video.videoHeight;
    const canvasWidth = state.overlayCanvas.width;
    const canvasHeight = state.overlayCanvas.height;

    // Draw connections
    const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4], // Thumb
        [0, 5], [5, 6], [6, 7], [7, 8], // Index
        [0, 9], [9, 10], [10, 11], [11, 12], // Middle
        [0, 13], [13, 14], [14, 15], [15, 16], // Ring
        [0, 17], [17, 18], [18, 19], [19, 20], // Pinky
        [5, 9], [9, 13], [13, 17] // Palm
    ];

    ctx.strokeStyle = 'rgba(50, 184, 198, 0.8)';
    ctx.lineWidth = 2;

    connections.forEach(([start, end]) => {
        const startPoint = hand.keypoints[start];
        const endPoint = hand.keypoints[end];
        
        const x1 = (1 - startPoint.x / videoWidth) * canvasWidth;
        const y1 = (startPoint.y / videoHeight) * canvasHeight;
        const x2 = (1 - endPoint.x / videoWidth) * canvasWidth;
        const y2 = (endPoint.y / videoHeight) * canvasHeight;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    });

    // Draw landmarks
    hand.keypoints.forEach((point, index) => {
        const x = (1 - point.x / videoWidth) * canvasWidth;
        const y = (point.y / videoHeight) * canvasHeight;

        ctx.fillStyle = index === 4 || index === 8 ? 'rgba(255, 0, 0, 0.9)' : 'rgba(50, 184, 198, 0.9)';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.fill();
    });

    // Draw color palette boxes on overlay
    const scaleX = canvasWidth / 1280;
    const scaleY = canvasHeight / 720;

    CONFIG.colorPalette.forEach(color => {
        const [x1, y1, x2, y2] = color.position;
        const [r, g, b] = color.rgb;
        
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1 * scaleX, y1 * scaleY, (x2 - x1) * scaleX, (y2 - y1) * scaleY);
        
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.5)`;
        ctx.fillRect(x1 * scaleX, y1 * scaleY, (x2 - x1) * scaleX, (y2 - y1) * scaleY);
    });
}

// Detect shapes in the drawing
function detectShapes() {
    const imageData = state.drawingCtx.getImageData(0, 0, state.drawingCanvas.width, state.drawingCanvas.height);
    const data = imageData.data;
    
    // Create binary image
    const binaryCanvas = document.createElement('canvas');
    binaryCanvas.width = state.drawingCanvas.width;
    binaryCanvas.height = state.drawingCanvas.height;
    const binaryCtx = binaryCanvas.getContext('2d');
    const binaryImageData = binaryCtx.createImageData(binaryCanvas.width, binaryCanvas.height);
    
    for (let i = 0; i < data.length; i += 4) {
        const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const value = avg > 50 ? 255 : 0;
        binaryImageData.data[i] = value;
        binaryImageData.data[i + 1] = value;
        binaryImageData.data[i + 2] = value;
        binaryImageData.data[i + 3] = 255;
    }
    
    binaryCtx.putImageData(binaryImageData, 0, 0);
    
    // Find contours (simplified version)
    const contours = findContours(binaryImageData);
    
    state.detectedShapes = [];
    
    contours.forEach(contour => {
        if (contour.area > CONFIG.gestureThresholds.shapeAreaMin) {
            const shape = classifyShape(contour);
            if (shape) {
                state.detectedShapes.push(shape);
            }
        }
    });
    
    // Update UI
    if (state.detectedShapes.length > 0) {
        const shapeNames = state.detectedShapes.map(s => s.name).join(', ');
        document.getElementById('shapeName').textContent = shapeNames;
        document.getElementById('shapeDetected').style.display = 'block';
    } else {
        document.getElementById('shapeDetected').style.display = 'none';
    }
}

// Find contours (simplified)
function findContours(imageData) {
    // This is a simplified contour detection
    // In production, you might want to use a library like OpenCV.js
    const contours = [];
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const visited = new Array(width * height).fill(false);
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            if (data[idx] > 128 && !visited[y * width + x]) {
                const contour = floodFill(x, y, data, visited, width, height);
                if (contour.points.length > 10) {
                    contours.push(contour);
                }
            }
        }
    }
    
    return contours;
}

// Flood fill algorithm
function floodFill(startX, startY, data, visited, width, height) {
    const points = [];
    const queue = [[startX, startY]];
    let minX = startX, maxX = startX, minY = startY, maxY = startY;
    
    while (queue.length > 0 && points.length < 10000) {
        const [x, y] = queue.shift();
        
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const idx = y * width + x;
        if (visited[idx]) continue;
        
        const pixelIdx = idx * 4;
        if (data[pixelIdx] < 128) continue;
        
        visited[idx] = true;
        points.push([x, y]);
        
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        
        queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    
    const area = points.length;
    const perimeter = (maxX - minX) * 2 + (maxY - minY) * 2;
    
    return {
        points,
        area,
        perimeter,
        boundingBox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    };
}

// Classify shape
function classifyShape(contour) {
    const { boundingBox, area, perimeter } = contour;
    const aspectRatio = boundingBox.width / boundingBox.height;
    
    // Calculate circularity: 4π * area / perimeter²
    const circularity = (4 * Math.PI * area) / (perimeter * perimeter);
    
    let shapeName = 'Unknown';
    
    if (circularity > 0.8) {
        shapeName = 'Circle';
    } else if (Math.abs(aspectRatio - 1) < 0.15) {
        shapeName = 'Square';
    } else if (aspectRatio > 0.5 && aspectRatio < 2) {
        shapeName = 'Rectangle';
    } else if (circularity < 0.5) {
        shapeName = 'Triangle';
    }
    
    return {
        name: shapeName,
        boundingBox,
        confidence: circularity
    };
}

// Update mode indicator
function updateModeIndicator(text, className = '') {
    const indicator = document.getElementById('modeIndicator');
    indicator.querySelector('h4').textContent = text;
    indicator.className = 'mode-indicator ' + className;
}

// Clear canvas
function clearCanvas() {
    state.drawingCtx.clearRect(0, 0, state.drawingCanvas.width, state.drawingCanvas.height);
    saveToHistory();
}

// Save to history
function saveToHistory() {
    const imageData = state.drawingCtx.getImageData(0, 0, state.drawingCanvas.width, state.drawingCanvas.height);
    
    // Remove any redo states
    state.history = state.history.slice(0, state.historyIndex + 1);
    
    state.history.push(imageData);
    state.historyIndex++;
    
    // Limit history size
    if (state.history.length > 50) {
        state.history.shift();
        state.historyIndex--;
    }
    
    updateHistoryUI();
}

// Undo
function undo() {
    if (state.historyIndex > 0) {
        state.historyIndex--;
        const imageData = state.history[state.historyIndex];
        state.drawingCtx.putImageData(imageData, 0, 0);
        updateHistoryUI();
    }
}

// Redo
function redo() {
    if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        const imageData = state.history[state.historyIndex];
        state.drawingCtx.putImageData(imageData, 0, 0);
        updateHistoryUI();
    }
}

// Update history UI
function updateHistoryUI() {
    document.getElementById('historyCount').textContent = state.history.length;
    document.getElementById('undoBtn').disabled = state.historyIndex <= 0;
    document.getElementById('redoBtn').disabled = state.historyIndex >= state.history.length - 1;
}

// Download drawing
function downloadDrawing() {
    const link = document.createElement('a');
    link.download = 'virtual-paint-drawing.png';
    link.href = state.drawingCanvas.toDataURL('image/png');
    link.click();
}

// Update FPS
function updateFPS() {
    const now = Date.now();
    const elapsed = now - state.lastFrameTime;
    
    if (elapsed >= 1000) {
        state.fps = Math.round((state.frameCount * 1000) / elapsed);
        document.getElementById('fps').textContent = state.fps;
        state.frameCount = 0;
        state.lastFrameTime = now;
    }
    
    requestAnimationFrame(updateFPS);
}

// Setup event listeners
function setupEventListeners() {
    // Color buttons
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const colorName = btn.dataset.color;
            const color = CONFIG.colorPalette.find(c => c.name.toLowerCase() === colorName);
            if (color) {
                state.currentColor = color.rgb;
                document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            }
        });
    });

    // Brush size
    const brushSizeSlider = document.getElementById('brushSize');
    brushSizeSlider.addEventListener('input', (e) => {
        state.brushSize = parseInt(e.target.value);
        document.getElementById('brushSizeValue').textContent = state.brushSize;
    });

    // Eraser size
    const eraserSizeSlider = document.getElementById('eraserSize');
    eraserSizeSlider.addEventListener('input', (e) => {
        state.eraserSize = parseInt(e.target.value);
        document.getElementById('eraserSizeValue').textContent = state.eraserSize;
    });

    // Action buttons
    document.getElementById('clearBtn').addEventListener('click', () => {
        clearCanvas();
    });

    document.getElementById('undoBtn').addEventListener('click', undo);
    document.getElementById('redoBtn').addEventListener('click', redo);
    document.getElementById('downloadBtn').addEventListener('click', downloadDrawing);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'c' || e.key === 'C') {
            clearCanvas();
        } else if (e.key === 'z' || e.key === 'Z') {
            if (e.shiftKey) {
                redo();
            } else {
                undo();
            }
        } else if (e.key === 's' || e.key === 'S') {
            e.preventDefault();
            downloadDrawing();
        }
    });

    // Handle window resize
    window.addEventListener('resize', () => {
        const container = document.querySelector('.canvas-container');
        const rect = container.getBoundingClientRect();
        
        // Save current drawing
        const imageData = state.drawingCtx.getImageData(0, 0, state.drawingCanvas.width, state.drawingCanvas.height);
        
        // Resize canvases
        [state.drawingCanvas, state.overlayCanvas].forEach(canvas => {
            canvas.width = rect.width;
            canvas.height = rect.height;
        });
        
        // Restore drawing (scaled)
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imageData.width;
        tempCanvas.height = imageData.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);
        
        state.drawingCtx.drawImage(tempCanvas, 0, 0, rect.width, rect.height);
    });
}

// Show error
function showError(message) {
    const overlay = document.getElementById('loadingOverlay');
    overlay.innerHTML = `
        <div class="error-message">
            <h2>Error</h2>
            <p>${message}</p>
        </div>
    `;
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}