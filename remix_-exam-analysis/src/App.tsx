/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { 
  Upload, 
  FileText, 
  BarChart3, 
  Layers, 
  Repeat, 
  Download, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  ChevronRight,
  BookOpen,
  History,
  Clock,
  Plus,
  Trash2,
  Folder,
  ChevronLeft,
  LogOut,
  User,
  Save,
  Search,
  HelpCircle,
  Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from "@google/genai";
import * as pdfjs from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import Markdown from 'react-markdown';
import { auth, db } from './firebase';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  deleteDoc, 
  doc, 
  serverTimestamp,
  orderBy,
  getDocs,
  setDoc,
  getDoc
} from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Something went wrong.";
      try {
        const parsed = JSON.parse(this.state.error.message);
        if (parsed.error) errorMessage = parsed.error;
      } catch (e) {
        errorMessage = this.state.error.message || errorMessage;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center border border-red-100">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-slate-900 mb-2">Application Error</h2>
            <p className="text-slate-600 mb-6">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// Types for our analysis
interface Question {
  text: string;
  chapter: string;
  frequency: number;
  years: string[];
  hasDiagram: boolean;
  diagramDescription?: string;
  diagramUrl?: string;
}

interface ChapterStats {
  name: string;
  count: number;
  percentage: number;
}

interface AnalysisResult {
  questions: Question[];
  chapters: ChapterStats[];
  totalQuestions: number;
  summary: string;
  modelQuestion: string;
  sourceImage?: string;
  id?: string;
  createdAt?: any;
}

interface UserProfile {
  userId: string;
  email: string;
  role: 'user' | 'admin';
  credits: number;
  isPremium: boolean;
  createdAt: any;
}

interface PaymentRequest {
  id?: string;
  userId: string;
  userEmail: string;
  amount: number;
  method: 'bKash' | 'Nagad';
  transactionId: string;
  planId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: any;
}

interface Subject {
  id: string;
  name: string;
  userId: string;
  createdAt: any;
}

interface AppSettings {
  id?: string;
  bkashNumber: string;
  nagadNumber: string;
  paymentManual: string;
  packages: {
    id: string;
    name: string;
    credits: number;
    price: number;
    description: string;
    isPremium: boolean;
  }[];
}

const GEMINI_MODEL = "gemini-3-flash-preview";

function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [activeSubject, setActiveSubject] = useState<Subject | null>(null);
  const [savedAnalyses, setSavedAnalyses] = useState<AnalysisResult[]>([]);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [isFixingQuestion, setIsFixingQuestion] = useState<number | null>(null);
  
  const [newSubjectName, setNewSubjectName] = useState("");
  const [isAddingSubject, setIsAddingSubject] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);

  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBtn(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShowInstallBtn(false);
    }
    setDeferredPrompt(null);
  };

  const [useOCR, setUseOCR] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState("");
  const [progressPercentage, setProgressPercentage] = useState(0);
  const [estimatedTimeRemaining, setEstimatedTimeRemaining] = useState<number | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [currentImages, setCurrentImages] = useState<{ data: string, mimeType: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [helpMessages, setHelpMessages] = useState<{ role: 'user' | 'ai', text: string }[]>([]);
  const [helpInput, setHelpInput] = useState("");
  const [isHelpLoading, setIsHelpLoading] = useState(false);
  const helpEndRef = useRef<HTMLDivElement>(null);

  const [refineInput, setRefineInput] = useState("");
  const [isRefining, setIsRefining] = useState(false);

  const [isAdminDashboardOpen, setIsAdminDashboardOpen] = useState(false);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [selectedPlanForPayment, setSelectedPlanForPayment] = useState<{ id: string, name: string, amount: number } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'bKash' | 'Nagad'>('bKash');
  const [transactionId, setTransactionId] = useState("");
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false);

  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [adminTab, setAdminTab] = useState<'requests' | 'settings' | 'users'>('requests');
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [isUserManualOpen, setIsUserManualOpen] = useState(false);

  useEffect(() => {
    helpEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [helpMessages]);

  const handleHelpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!helpInput.trim() || isHelpLoading) return;

    const userMsg = helpInput.trim();
    setHelpInput("");
    setHelpMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsHelpLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const context = `
        You are an AI Help Center assistant for VersityAnalyzer.
        VersityAnalyzer is an app that analyzes university question banks (PDFs/Images) using Gemini AI.
        It extracts questions, categorizes them by chapter, tracks frequency, and generates model papers.
        
        Current App State:
        - User: ${user?.displayName || 'Anonymous'}
        - Active Subject: ${activeSubject?.name || 'None selected'}
        - Analysis Result: ${result ? 'Available' : 'Not available'}
        
        Help the user with any questions about the app, how to use it, or how to interpret the results.
        Keep your answers concise and helpful.
      `;

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          { role: "user", parts: [{ text: context + "\n\nUser Question: " + userMsg }] }
        ]
      });

      setHelpMessages(prev => [...prev, { role: 'ai', text: response.text || "I'm sorry, I couldn't process that." }]);
    } catch (err) {
      console.error("Help AI error:", err);
      setHelpMessages(prev => [...prev, { role: 'ai', text: "Sorry, I'm having trouble connecting right now." }]);
    } finally {
      setIsHelpLoading(false);
    }
  };

  const refineAnalysis = async () => {
    if (!refineInput.trim() || !result || isRefining) return;
    setIsRefining(true);
    setProgress("Refining analysis based on your request...");
    setIsAnalyzing(true);
    setProgressPercentage(50);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `
        You are refining a previous question bank analysis.
        
        PREVIOUS ANALYSIS:
        ${JSON.stringify(result)}
        
        USER REQUEST FOR REFINEMENT:
        "${refineInput}"
        
        TASK:
        Update the analysis based on the user's request. Return a complete, valid JSON object matching the original schema.
        If the user wants to fix something, fix it. If they want to add something, add it.
        Ensure the 'percentage' in chapters still adds up to 100.
        Maintain the 'sourceImage' if it exists.
      `;

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              questions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING },
                    chapter: { type: Type.STRING },
                    frequency: { type: Type.NUMBER },
                    years: { type: Type.ARRAY, items: { type: Type.STRING } },
                    hasDiagram: { type: Type.BOOLEAN },
                    diagramDescription: { type: Type.STRING }
                  },
                  required: ["text", "chapter", "frequency", "years", "hasDiagram"]
                }
              },
              chapters: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    count: { type: Type.NUMBER },
                    percentage: { type: Type.NUMBER }
                  },
                  required: ["name", "count", "percentage"]
                }
              },
              totalQuestions: { type: Type.NUMBER },
              summary: { type: Type.STRING },
              modelQuestion: { type: Type.STRING }
            },
            required: ["questions", "chapters", "totalQuestions", "summary", "modelQuestion"]
          }
        }
      });

      const updatedResult = JSON.parse(response.text || "{}") as AnalysisResult;
      updatedResult.sourceImage = result.sourceImage; // Keep source image
      
      // Re-generate diagrams if needed
      if (updatedResult.questions) {
        const newDiagramQuestions = updatedResult.questions.filter(q => q.hasDiagram && q.diagramDescription && !q.diagramUrl);
        for (const q of newDiagramQuestions) {
          const url = await generateDiagram(q.diagramDescription!, currentImages);
          if (url) q.diagramUrl = url;
        }
      }

      setResult(updatedResult);
      setRefineInput("");
      showToast("Analysis refined successfully!");
    } catch (err) {
      console.error("Refine error:", err);
      setError("Failed to refine analysis. Please try again.");
    } finally {
      setIsRefining(false);
      setIsAnalyzing(false);
    }
  };

  // Auth Listener
  React.useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsAuthReady(true);
    });
    
    // Safety timeout for auth state
    const timer = setTimeout(() => {
      if (!isAuthReady) {
        console.warn("Auth state took too long to load, forcing ready state.");
        setIsAuthReady(true);
      }
    }, 5000);
    
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [isAuthReady]);

  // Ensure user document exists and listen for changes
  React.useEffect(() => {
    if (!user) {
      setUserProfile(null);
      return;
    }

    const userRef = doc(db, "users", user.uid);
    
    // Initial check and migration
    const ensureUserDoc = async () => {
      try {
        const userSnap = await getDoc(userRef);
        const isAdminEmail = user.email === "abirgaming622@gmail.com";
        
        if (!userSnap.exists()) {
          const newProfile = {
            userId: user.uid,
            email: user.email || "",
            role: isAdminEmail ? 'admin' : 'user',
            credits: 5,
            isPremium: false,
            createdAt: serverTimestamp()
          };
          await setDoc(userRef, newProfile);
        } else {
          const data = userSnap.data();
          const needsDemotion = !isAdminEmail && data.role === 'admin';
          // Migration: If existing user is missing credits, isPremium, or createdAt, add them, or demote if not admin email
          if (data.credits === undefined || data.isPremium === undefined || data.createdAt === undefined || (isAdminEmail && data.role !== 'admin') || needsDemotion) {
            const updatedProfile = {
              ...data,
              userId: data.userId || data.uid || user.uid,
              email: data.email || user.email || "",
              role: isAdminEmail ? 'admin' : 'user',
              credits: data.credits ?? 5,
              isPremium: data.isPremium ?? false,
              createdAt: data.createdAt || serverTimestamp()
            };
            // Remove any potential undefined fields before writing
            Object.keys(updatedProfile).forEach(key => 
              (updatedProfile as any)[key] === undefined && delete (updatedProfile as any)[key]
            );
            await setDoc(userRef, updatedProfile, { merge: true });
          }
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
      }
    };

    ensureUserDoc();

    // Real-time listener
    const unsubscribe = onSnapshot(userRef, (snapshot) => {
      if (snapshot.exists()) {
        setUserProfile(snapshot.data() as UserProfile);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}`);
    });

    return () => unsubscribe();
  }, [user]);

  // Fetch App Settings
  React.useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, "settings", "global"), (snapshot) => {
      if (snapshot.exists()) {
        setAppSettings({ id: snapshot.id, ...snapshot.data() } as AppSettings);
      } else {
        // Initialize default settings if they don't exist
        const defaultSettings: AppSettings = {
          bkashNumber: "017XXXXXXXX",
          nagadNumber: "017XXXXXXXX",
          paymentManual: "1. Open your bKash or Nagad app.\n2. Select \"Send Money\".\n3. Enter the number provided above.\n4. Enter the amount: {amount} TK.\n5. Complete the transaction and copy the Transaction ID.\n6. Select your payment method below and paste the ID.",
          packages: [
            { id: "50", name: "Starter Pack", credits: 50, price: 50, description: "50 Analysis Credits", isPremium: false },
            { id: "100", name: "6 Month Plan", credits: 100, price: 80, description: "100 Credits (Valid for 6 Months)", isPremium: false },
            { id: "9999", name: "1 Year Premium", credits: 9999, price: 200, description: "Unlimited Analysis & PDF Downloads", isPremium: true }
          ]
        };
        setDoc(doc(db, "settings", "global"), defaultSettings).catch(err => 
          console.error("Error initializing settings:", err)
        );
        setAppSettings(defaultSettings);
      }
    }, (error) => {
      console.error("Error fetching settings:", error);
    });
    return () => unsubscribe();
  }, []);

  // Fetch All Users for Admin
  React.useEffect(() => {
    if (!user || !userProfile || userProfile.role !== 'admin' || adminTab !== 'users' || user.email !== "abirgaming622@gmail.com") {
      setAllUsers([]);
      return;
    }
    
    const q = query(collection(db, "users"), orderBy("createdAt", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setAllUsers(snapshot.docs.map(doc => ({ ...doc.data() } as UserProfile)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "users");
    });
    
    return () => unsubscribe();
  }, [userProfile, adminTab]);

  // Fetch Payment Requests for Admin
  React.useEffect(() => {
    if (!user || !userProfile || userProfile.role !== 'admin' || user.email !== "abirgaming622@gmail.com") {
      setPaymentRequests([]);
      return;
    }
    
    const q = query(
      collection(db, "paymentRequests"),
      orderBy("createdAt", "desc")
    );
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const requests = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as PaymentRequest[];
      setPaymentRequests(requests);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "paymentRequests");
    });
    
    return () => unsubscribe();
  }, [userProfile]);

  // Fetch Subjects
  React.useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "subjects"), 
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc")
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setSubjects(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Subject)));
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "subjects");
    });
    return () => unsubscribe();
  }, [user]);

  // Fetch Saved Analyses
  React.useEffect(() => {
    if (!user || !activeSubject) {
      setSavedAnalyses([]);
      return;
    }
    const q = query(
      collection(db, "analyses"), 
      where("subjectId", "==", activeSubject.id),
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc")
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setSavedAnalyses(snapshot.docs.map(doc => ({ 
        id: doc.id, 
        ...doc.data().result,
        createdAt: doc.data().createdAt 
      } as AnalysisResult)));
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "analyses");
    });
    return () => unsubscribe();
  }, [user, activeSubject]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login failed", err);
    }
  };

  const handleLogout = () => signOut(auth);

  const addSubject = async () => {
    if (!user || !newSubjectName.trim()) return;
    try {
      await addDoc(collection(db, "subjects"), {
        name: newSubjectName.trim(),
        userId: user.uid,
        createdAt: serverTimestamp()
      });
      setNewSubjectName("");
      setIsAddingSubject(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, "subjects");
    }
  };

  const deleteSubject = async (id: string) => {
    setConfirmModal({
      isOpen: true,
      title: "Delete Subject",
      message: "Are you sure you want to delete this subject and all its analysis history? This action cannot be undone.",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "subjects", id));
          if (activeSubject?.id === id) {
            setActiveSubject(null);
          }
          setConfirmModal(null);
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `subjects/${id}`);
        }
      }
    });
  };

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const saveAnalysis = async (analysisResult: AnalysisResult) => {
    if (!user || !activeSubject) return;
    try {
      await addDoc(collection(db, "analyses"), {
        subjectId: activeSubject.id,
        userId: user.uid,
        result: analysisResult,
        createdAt: serverTimestamp()
      });
      showToast("Analysis saved successfully!");
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "analyses");
    }
  };

  const extractTextFromPDF = async (file: File, onProgress: (p: number) => void): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(" ");
      fullText += `--- Page ${i} ---\n${pageText}\n\n`;
      onProgress(Math.round((i / pdf.numPages) * 100));
    }
    return fullText;
  };

  const extractImagesFromPDF = async (file: File, onProgress: (p: number) => void): Promise<{ data: string, mimeType: string }[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    const images: { data: string, mimeType: string }[] = [];
    
    // Increased page limit to 30 for better coverage
    const pagesToProcess = Math.min(pdf.numPages, 30);
    
    for (let i = 1; i <= pagesToProcess; i++) {
      const page = await pdf.getPage(i);
      // Adjusted scale to 1.5 to ensure we stay well within payload limits for 30 pages
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      
      if (context) {
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        await page.render({
          canvasContext: context,
          viewport: viewport,
          // @ts-ignore - pdfjs-dist types can be tricky
          canvas: canvas
        }).promise;
        
        // Lowered quality to 0.6 to ensure 30 pages fit in the 20MB payload limit
        // 0.6 is still very readable for OCR
        const base64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
        images.push({ data: base64, mimeType: 'image/jpeg' });
        onProgress(Math.round((i / pagesToProcess) * 100));
      }
    }
    return images;
  };

  const generateDiagram = async (description: string, originalImages?: { data: string, mimeType: string }[]): Promise<string | undefined> => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const parts: any[] = [
        {
          text: `You are a professional academic illustrator. Your task is to REPLICATE the diagram from the provided source images with 100% accuracy.
          
          DIAGRAM DESCRIPTION: ${description}
          
          INSTRUCTIONS:
          1. Use the attached images as the primary reference.
          2. Replicate all shapes, lines, connections, and labels EXACTLY as they appear in the original.
          3. Digitally clean up the diagram: make it high-contrast black and white.
          4. Ensure all text, labels, and mathematical symbols are perfectly legible.
          5. The final output must look like a professional, digitized version of the original exam diagram.
          6. NO COLORS. ONLY BLACK LINES ON A WHITE BACKGROUND.`,
        },
      ];

      if (originalImages && originalImages.length > 0) {
        originalImages.forEach(img => {
          parts.push({
            inlineData: {
              data: img.data,
              mimeType: img.mimeType
            }
          });
        });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts },
        config: {
          imageConfig: {
            aspectRatio: "1:1"
          }
        }
      });

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
    } catch (err) {
      console.error("Failed to generate diagram:", err);
    }
    return undefined;
  };

  const fixQuestionWithAI = async (questionIndex: number) => {
    if (!result || isFixingQuestion !== null) return;
    
    setIsFixingQuestion(questionIndex);
    try {
      const q = result.questions[questionIndex];
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const prompt = `
        The following academic question contains unreadable characters, symbols, or formatting errors due to OCR issues. 
        Please reconstruct it into a perfectly readable, professional academic question.
        
        ORIGINAL QUESTION: "${q.text}"
        CHAPTER/TOPIC: "${q.chapter}"
        
        INSTRUCTIONS:
        1. Fix all spelling and grammar.
        2. Reconstruct mathematical symbols and formulas correctly (e.g. use x^2 instead of x2 if it's a square).
        3. Ensure the question makes logical sense in the context of the topic.
        4. Return ONLY the corrected question text.
      `;
      
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      
      const fixedText = response.text || q.text;
      
      const updatedQuestions = [...result.questions];
      updatedQuestions[questionIndex] = { ...q, text: fixedText };
      
      setResult({ ...result, questions: updatedQuestions });
      showToast("Question fixed with AI!");
    } catch (err) {
      console.error("Fix question error:", err);
      setError("Failed to fix question with AI.");
    } finally {
      setIsFixingQuestion(null);
    }
  };

  const buyCredits = (amount: number, price: number, planName: string) => {
    if (!user || !userProfile) return;
    setSelectedPlanForPayment({ id: amount.toString(), name: planName, amount: price });
  };

  const submitPaymentRequest = async () => {
    if (!user || !userProfile || !selectedPlanForPayment || !transactionId.trim()) return;
    
    setIsSubmittingPayment(true);
    try {
      const requestData: PaymentRequest = {
        userId: user.uid,
        userEmail: user.email || "",
        amount: selectedPlanForPayment.amount,
        method: paymentMethod,
        transactionId: transactionId.trim(),
        planId: selectedPlanForPayment.id,
        status: 'pending',
        createdAt: serverTimestamp()
      };
      
      await addDoc(collection(db, "paymentRequests"), requestData);
      
      showToast("Payment request submitted! Admin will verify soon.");
      setSelectedPlanForPayment(null);
      setTransactionId("");
      setIsPricingOpen(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "paymentRequests");
    } finally {
      setIsSubmittingPayment(false);
    }
  };

  const updateAppSettings = async (newSettings: AppSettings) => {
    try {
      const { id, ...data } = newSettings;
      await setDoc(doc(db, "settings", "global"), data);
      showToast("Settings updated successfully!");
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, "settings/global");
    }
  };

  const updateUserCredits = async (userId: string, newCredits: number) => {
    try {
      await setDoc(doc(db, "users", userId), { credits: newCredits }, { merge: true });
      showToast("User credits updated!");
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${userId}`);
    }
  };

  const handleAdminAction = async (requestId: string, status: 'approved' | 'rejected') => {
    const request = paymentRequests.find(r => r.id === requestId);
    if (!request) return;

    try {
      // 1. Update request status
      await setDoc(doc(db, "paymentRequests", requestId), { status }, { merge: true });

      if (status === 'approved') {
        // 2. Update user credits/premium status
        const userRef = doc(db, "users", request.userId);
        const userSnap = await getDoc(userRef);
        
        if (userSnap.exists()) {
          const userData = userSnap.data() as UserProfile;
          const amount = parseInt(request.planId);
          const isPremiumPurchase = amount === 9999;
          
          const updatedData = {
            ...userData,
            credits: isPremiumPurchase ? (userData.credits || 0) : (userData.credits || 0) + amount,
            isPremium: isPremiumPurchase || (userData.isPremium || false)
          };

          await setDoc(userRef, updatedData, { merge: true });
          showToast(`Request approved for ${request.userEmail}`);
        }
      } else {
        showToast(`Request rejected for ${request.userEmail}`);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `paymentRequests/${requestId}`);
    }
  };

  const analyzeWithAI = async (text: string, images?: { data: string, mimeType: string }[]) => {
    if (!userProfile || (userProfile.credits < 10 && !userProfile.isPremium)) {
      setIsPricingOpen(true);
      throw new Error("You need at least 10 credits for an analysis. Please upgrade to continue.");
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const parts: any[] = [];
      
      if (images && images.length > 0) {
        images.forEach(img => {
          parts.push({
            inlineData: {
              data: img.data,
              mimeType: img.mimeType
            }
          });
        });
      }
      
      const prompt = `
        You are an elite academic document digitizer and analyzer, specializing in both theoretical and mathematical subjects. I am providing you with ${images ? 'high-resolution images of pages' : 'text extracted'} from a university question bank.
        
        ${images ? 'CRITICAL VISION INSTRUCTIONS: The images may contain blurred text, handwritten notes, complex mathematical formulas, equations, symbols (like integrals, summations, Greek letters), and geometric diagrams/figures. Use your advanced vision capabilities to reconstruct the text and math accurately. Look for patterns typical of exam papers: numbered lists (1, 2, 3...), lettered sub-questions (a, b, c...), and action verbs like "Define", "Explain", "Calculate", "Prove", "Solve", "Derive", "Discuss".' : ''}

        TASK:
        1. EXTRACT EVERY QUESTION: Scour the ${images ? 'images' : 'text'} for anything that looks like an exam question. Pay special attention to mathematical problems, formulas, and proofs.
        2. IDENTIFY DIAGRAMS: If a question refers to a diagram, figure, or graph (e.g., "In the figure below...", "Refer to the diagram..."), set 'hasDiagram' to true. 
           Provide a detailed 'diagramDescription' that acts as a RECONSTRUCTION PROMPT. 
           This description MUST include:
           - The type of diagram (e.g., circuit, geometric shape, graph, flowchart).
           - All labels, numbers, and variables present in the original diagram.
           - The spatial relationship between elements.
           - Any specific values or units mentioned.
           The goal is to provide enough detail so another AI can perfectly replicate the original diagram.
        3. CATEGORIZE: Group each question into its most likely academic chapter or topic. If the subject isn't clear, use "General/Uncategorized".
        4. FREQUENCY ANALYSIS: Count how many times each question (or a very similar version) appears across the pages.
        5. YEAR TRACKING: Note the specific years, terms, or marks mentioned next to each question.
        6. TREND SUMMARY: Provide a high-level summary of the exam trends and which chapters are most important for preparation.
        7. GENERATE AN ELABORATE 8-SET MODEL QUESTION PAPER: Based on all the extracted questions and identified trends, create a "Master Model Question Paper" that follows a standard final exam format. 
           - Use Markdown formatting for the output.
           - Use CLEAR BOLD HEADINGS (e.g., ## SECTION A) for each section.
           - Use numbered lists for questions.
           - Ensure the structure is:
             * ## SECTION A (Short Answer Questions): 10 questions (2 marks each).
             * ## SECTION B (Long/Essay Questions): 8 sets (Set 1 to Set 8), each with sub-questions (a and b).
           - Do NOT use literal escape sequences like "\\n" or "\\8" in the text. Use actual newline characters.
           - Format the output so it is highly readable and professional.

        STRICT INSTRUCTIONS:
        - DO NOT BE OVERLY PICKY. If it looks like a question, include it.
        - For MATH questions: Ensure formulas are transcribed clearly using standard notation (e.g., LaTeX-style or clear text representation like x^2, sqrt(y)).
        - IMPORTANT: If you use LaTeX, ensure all backslashes are DOUBLE ESCAPED for JSON compatibility (e.g., use "\\\\frac" instead of "\\frac").
        - If you find fragmented text that clearly belongs to a question, try to reconstruct the full question.
        - Ensure the 'percentage' in chapters adds up to approximately 100.
        - If you find NO questions, you MUST explain exactly what you see in the images in the 'summary' field.
        - Keep the 'summary' and 'modelQuestion' fields concise but informative.
        
        ${text ? `TEXT TO ANALYZE:\n${text.substring(0, 100000)}` : 'Please analyze the attached images with maximum focus on identifying every possible question, including mathematical ones and those with diagrams.'}
      `;

      parts.push({ text: prompt });

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: parts }],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              questions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING },
                    chapter: { type: Type.STRING },
                    frequency: { type: Type.NUMBER },
                    years: { type: Type.ARRAY, items: { type: Type.STRING } },
                    hasDiagram: { type: Type.BOOLEAN },
                    diagramDescription: { type: Type.STRING }
                  },
                  required: ["text", "chapter", "frequency", "years", "hasDiagram"]
                }
              },
              chapters: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    count: { type: Type.NUMBER },
                    percentage: { type: Type.NUMBER }
                  },
                  required: ["name", "count", "percentage"]
                }
              },
              totalQuestions: { type: Type.NUMBER },
              summary: { type: Type.STRING },
              modelQuestion: { type: Type.STRING }
            },
            required: ["questions", "chapters", "totalQuestions", "summary", "modelQuestion"]
          },
          temperature: 0.1,
          maxOutputTokens: 16384,
        }
      });

      let rawText = response.text || "{}";
      console.log("AI Raw Response Length:", rawText.length);
      
      // Robust JSON extraction: sometimes AI adds markdown wrappers or extra text
      try {
        // Try to find the first '{' and last '}' to extract the JSON object
        const firstBrace = rawText.indexOf('{');
        const lastBrace = rawText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          rawText = rawText.substring(firstBrace, lastBrace + 1);
        }
        
        const data = JSON.parse(rawText);
        return data as AnalysisResult;
      } catch (parseErr: any) {
        console.error("Initial JSON parse failed, attempting repair:", parseErr);
        
        // Basic repair for common AI JSON issues (like unescaped backslashes in LaTeX)
        try {
          // If it's an unterminated string error, it might be due to a single backslash
          // We can try to escape backslashes that aren't already escaped
          // This is a bit aggressive but can help with LaTeX content
          const repairedText = rawText
            .replace(/\\(?![\\"\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\')
            // Also handle potential trailing commas before closing braces/brackets
            .replace(/,\s*([}\]])/g, '$1');
            
          const data = JSON.parse(repairedText);
          return data as AnalysisResult;
        } catch (repairErr) {
          console.error("JSON repair failed:", repairErr);
          // If repair fails, throw a more descriptive error if it's a truncation issue
          if (rawText.length > 10000 && !rawText.trim().endsWith('}')) {
            throw new Error("The AI response was truncated because it was too long. Try analyzing fewer pages at a time.");
          }
          throw parseErr; // Throw the original error if repair fails
        }
      }
    } catch (err: any) {
      console.error("AI Analysis failed:", err);
      if (err.message?.includes("413") || err.message?.includes("too large")) {
        throw new Error("The document is too large for the AI to process at once. Please try uploading a PDF with fewer pages or disable 'OCR Mode'.");
      }
      if (err instanceof SyntaxError) {
        throw new Error("The AI returned an invalid response. This often happens with very long documents. Try analyzing fewer pages at a time.");
      }
      throw new Error("Failed to analyze questions with AI. This might be due to a connection error or a temporary service issue. Please try again.");
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isAnalyzing) return;
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    // Check credits before starting
    if (user && userProfile && userProfile.role !== 'admin' && !userProfile.isPremium && (userProfile.credits || 0) < 10) {
      setError("You don't have enough credits to perform this analysis. Each analysis costs 10 credits.");
      setIsPricingOpen(true);
      return;
    }
    
    const isPDF = selectedFile.type === 'application/pdf';
    const isImage = selectedFile.type.startsWith('image/');

    if (!isPDF && !isImage) {
      setError("Please upload a PDF or an image file.");
      return;
    }

    setFile(selectedFile);
    setError(null);
    setResult(null);
    setIsAnalyzing(true);
    setProgressPercentage(0);
    
    let timer: any = null;
    
    try {
      let text = "";
      let images: { data: string, mimeType: string }[] | undefined = undefined;

      if (isImage) {
        setProgress("Processing image...");
        setEstimatedTimeRemaining(15);
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(selectedFile);
        });
        images = [{ data: base64, mimeType: selectedFile.type }];
        setProgressPercentage(30);
      } else {
        const arrayBuffer = await selectedFile.arrayBuffer();
        const pdfDoc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdfDoc.numPages;
        const pagesToProcess = useOCR ? Math.min(numPages, 30) : numPages;

        // Estimated total time calculation
        let totalEstimatedSeconds = useOCR 
          ? Math.round(pagesToProcess * 2.5 + 30) 
          : Math.round(numPages * 0.5 + 15);
        
        setEstimatedTimeRemaining(totalEstimatedSeconds);

        timer = setInterval(() => {
          setEstimatedTimeRemaining(prev => {
            if (prev === null) return null;
            if (prev <= 1) {
              setProgress("Still working... almost there!");
              return 1;
            }
            return prev - 1;
          });
        }, 1000);

        if (useOCR) {
          setProgress(`Rendering ${pagesToProcess} pages for OCR...`);
          images = await extractImagesFromPDF(selectedFile, (p) => {
            setProgressPercentage(Math.round(p * 0.3));
          });
        } else {
          setProgress(`Extracting text from ${numPages} pages...`);
          text = await extractTextFromPDF(selectedFile, (p) => {
            setProgressPercentage(Math.round(p * 0.15));
          });
          
          if (!text || text.trim().length < 10) {
            throw new Error("No readable text found in this PDF. It might be a scanned image. Please enable 'OCR Mode' and try again.");
          }
        }
      }
      
      setProgress("Analyzing questions with Gemini AI...");
      const currentP = isImage ? 30 : (useOCR ? 30 : 15);
      const aiInterval = setInterval(() => {
        setProgressPercentage(prev => {
          if (prev < 98) return prev + 1;
          return 98;
        });
      }, 1000);

      const analysis = await analyzeWithAI(text, images);
      clearInterval(aiInterval);
      
      if (isImage && images && images.length > 0) {
        analysis.sourceImage = `data:${selectedFile.type};base64,${images[0].data}`;
      }

      // Generate diagrams for questions that have them
      if (analysis.questions) {
        setProgress("Generating AI diagrams for questions...");
        const questionsWithDiagrams = analysis.questions.filter(q => q.hasDiagram && q.diagramDescription);
        
        for (let i = 0; i < questionsWithDiagrams.length; i++) {
          const q = questionsWithDiagrams[i];
          setProgress(`Generating diagram ${i + 1}/${questionsWithDiagrams.length}...`);
          const url = await generateDiagram(q.diagramDescription!, images);
          if (url) {
            q.diagramUrl = url;
          }
          // Small delay to avoid rate limits
          await new Promise(r => setTimeout(r, 500));
        }
      }
      
      if (!analysis.questions || analysis.questions.length === 0) {
        const reason = analysis.summary || "No clear questions were found in the document.";
        throw new Error(`The AI couldn't identify any questions. Reason: ${reason}`);
      }
      
      setResult(analysis);
      setCurrentImages(images || []);
      
      // Deduct credit
      if (user && userProfile && userProfile.role !== 'admin' && !userProfile.isPremium) {
        const userRef = doc(db, "users", user.uid);
        const newCredits = Math.max(0, (userProfile.credits || 0) - 10);
        try {
          await setDoc(userRef, { credits: newCredits }, { merge: true });
          // No need to manually update state here as onSnapshot will handle it
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
        }
      }

      setProgressPercentage(100);
      setProgress("Analysis complete!");
    } catch (err: any) {
      console.error("Upload handler error:", err);
      setError(err.message || "An error occurred during analysis.");
    } finally {
      setIsAnalyzing(false);
      if (timer) clearInterval(timer);
      setEstimatedTimeRemaining(null);
    }
  };

  const generatePDFReport = () => {
    if (!result) return;
    
    if (!userProfile?.isPremium) {
      setIsPricingOpen(true);
      showToast("PDF Download is a Premium feature. Please upgrade to unlock.");
      return;
    }

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    let currentY = 22;

    const checkPageBreak = (neededHeight: number) => {
      if (currentY + neededHeight > pageHeight - 20) {
        doc.addPage();
        currentY = 20;
        return true;
      }
      return false;
    };

    // Title
    doc.setFontSize(22);
    doc.setTextColor(40, 40, 40);
    doc.text("University Question Analysis Report", margin, currentY);
    currentY += 10;
    
    doc.setFontSize(12);
    doc.setTextColor(100, 100, 100);
    doc.text(`Subject: ${activeSubject?.name || "N/A"}`, margin, currentY);
    currentY += 6;
    doc.text(`File: ${file?.name || "N/A"}`, margin, currentY);
    currentY += 6;
    doc.text(`Date: ${new Date().toLocaleDateString()}`, margin, currentY);
    currentY += 15;

    // Summary
    doc.setFontSize(16);
    doc.setTextColor(42, 85, 244);
    doc.text("Executive Summary", margin, currentY);
    currentY += 8;
    doc.setFontSize(11);
    doc.setTextColor(60, 60, 60);
    const splitSummary = doc.splitTextToSize(result.summary, pageWidth - (margin * 2));
    doc.text(splitSummary, margin, currentY);
    currentY += (splitSummary.length * 5) + 15;

    // Model Question
    checkPageBreak(20);
    doc.setFontSize(16);
    doc.setTextColor(42, 85, 244);
    doc.text("Master Model Question Paper", margin, currentY);
    currentY += 8;
    doc.setFontSize(10);
    doc.setTextColor(40, 40, 40);
    
    // Simple markdown cleaning for PDF
    const cleanModel = result.modelQuestion
      .replace(/^#+\s+/gm, '') // Remove headers
      .replace(/\*\*/g, '')    // Remove bold
      .replace(/\*/g, '');     // Remove italic
      
    const splitModel = doc.splitTextToSize(cleanModel, pageWidth - (margin * 2));
    
    // Handle multi-page model question
    splitModel.forEach((line: string) => {
      if (checkPageBreak(6)) {
        currentY = 20;
      }
      doc.text(line, margin, currentY);
      currentY += 5;
    });
    currentY += 15;

    // Chapter Distribution Table
    checkPageBreak(40);
    doc.setFontSize(16);
    doc.setTextColor(42, 85, 244);
    doc.text("Chapter Distribution", margin, currentY);
    autoTable(doc, {
      startY: currentY + 6,
      head: [['Chapter Name', 'Question Count', 'Weightage (%)']],
      body: result.chapters.map(c => [c.name, c.count, `${c.percentage}%`]),
      theme: 'striped',
      headStyles: { fillColor: [66, 133, 244] },
      margin: { left: margin, right: margin }
    });

    // Repeated Questions Table
    currentY = ((doc as any).lastAutoTable?.finalY || currentY) + 15;
    checkPageBreak(40);
    doc.setFontSize(16);
    doc.setTextColor(42, 85, 244);
    doc.text("Question Frequency Analysis", margin, currentY);
    
    autoTable(doc, {
      startY: currentY + 6,
      head: [['Question', 'Chapter', 'Frequency', 'Diagram Info']],
      body: result.questions
        .sort((a, b) => b.frequency - a.frequency)
        .map(q => [
          q.text,
          q.chapter,
          q.frequency,
          q.hasDiagram ? `Yes: ${q.diagramDescription || "See diagram"}` : "No"
        ]),
      theme: 'grid',
      headStyles: { fillColor: [52, 168, 83] },
      columnStyles: {
        0: { cellWidth: 80 },
        1: { cellWidth: 30 },
        2: { cellWidth: 20 },
        3: { cellWidth: 40 }
      },
      margin: { left: margin, right: margin }
    });

    const safeFileName = (file?.name || "Analysis").replace(/[^a-z0-9]/gi, '_').toLowerCase();
    doc.save(`${safeFileName}_Report.pdf`);
    showToast("PDF exported successfully!");
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans selection:bg-blue-100 flex">
      {!isAuthReady ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
        </div>
      ) : !user ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-md w-full bg-white rounded-3xl p-10 shadow-2xl border border-slate-100 text-center"
          >
            <div className="bg-blue-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-200">
              <BookOpen className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">VersityAnalyzer</h1>
            <p className="text-slate-500 mb-8">Sign in to manage your question banks and save your analysis results.</p>
            <button 
              onClick={handleLogin}
              className="w-full flex items-center justify-center gap-3 bg-white border border-slate-200 py-3 rounded-xl font-semibold text-slate-700 hover:bg-slate-50 transition-all shadow-sm"
            >
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="Google" />
              Sign in with Google
            </button>
          </motion.div>
        </div>
      ) : (
        <>
          {/* Sidebar */}
          <motion.aside 
            initial={false}
            animate={{ width: isSidebarOpen ? 320 : 0, opacity: isSidebarOpen ? 1 : 0 }}
            className="bg-white border-r border-slate-200 flex flex-col overflow-hidden h-screen sticky top-0"
          >
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-blue-600" />
                <span className="font-bold text-slate-800">VersityAnalyzer</span>
              </div>
              <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden">
                <ChevronLeft className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-8">
              {/* User Manual Button */}
              <button 
                onClick={() => setIsUserManualOpen(true)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-blue-50 text-blue-700 rounded-xl hover:bg-blue-100 transition-all font-bold text-sm border border-blue-100 shadow-sm"
              >
                <Info className="w-5 h-5" />
                User Manual
              </button>

              {/* Subjects Section */}
              <div className="space-y-4">
                <div className="flex items-center justify-between px-2">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Subjects</h3>
                  <button onClick={() => setIsAddingSubject(true)} className="p-1 hover:bg-slate-100 rounded text-blue-600">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {isAddingSubject && (
                  <div className="px-2 space-y-2">
                    <input 
                      autoFocus
                      type="text"
                      value={newSubjectName}
                      onChange={(e) => setNewSubjectName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addSubject();
                        if (e.key === 'Escape') setIsAddingSubject(false);
                      }}
                      placeholder="Subject name..."
                      className="w-full px-3 py-2 text-sm border border-blue-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <div className="flex gap-2">
                      <button 
                        onClick={addSubject}
                        className="flex-1 py-1 text-xs font-bold bg-blue-600 text-white rounded-md hover:bg-blue-700"
                      >
                        Add
                      </button>
                      <button 
                        onClick={() => { setIsAddingSubject(false); setNewSubjectName(""); }}
                        className="flex-1 py-1 text-xs font-bold bg-slate-100 text-slate-600 rounded-md hover:bg-slate-200"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <div className="space-y-1">
                  {subjects.map(s => (
                    <div 
                      key={s.id}
                      onClick={() => {
                        setActiveSubject(s);
                        setResult(null);
                      }}
                      className={`group flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors ${activeSubject?.id === s.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-slate-50 text-slate-600'}`}
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <Folder className={`w-4 h-4 shrink-0 ${activeSubject?.id === s.id ? 'text-blue-600' : 'text-slate-400'}`} />
                        <span className="text-sm font-medium truncate">{s.name}</span>
                      </div>
                      <button 
                        onClick={(e) => { e.stopPropagation(); deleteSubject(s.id); }}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-600 transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Saved Analyses Section */}
              {activeSubject && savedAnalyses.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest px-2">History</h3>
                  <div className="space-y-1">
                    {savedAnalyses.map(analysis => (
                      <div 
                        key={analysis.id}
                        onClick={() => setResult(analysis)}
                        className={`group flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors ${result?.id === analysis.id ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-slate-50 text-slate-600'}`}
                      >
                        <div className="flex items-center gap-2 overflow-hidden">
                          <Clock className={`w-4 h-4 shrink-0 ${result?.id === analysis.id ? 'text-emerald-600' : 'text-slate-400'}`} />
                          <div className="flex flex-col overflow-hidden">
                            <span className="text-xs font-medium truncate">Analysis Result</span>
                            <span className="text-[10px] opacity-60">
                              {analysis.createdAt?.toDate().toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                        <button 
                          onClick={async (e) => { 
                            e.stopPropagation(); 
                            setConfirmModal({
                              isOpen: true,
                              title: "Delete Analysis",
                              message: "Are you sure you want to delete this saved analysis?",
                              onConfirm: async () => {
                                try {
                                  await deleteDoc(doc(db, "analyses", analysis.id!));
                                  if (result?.id === analysis.id) setResult(null);
                                  setConfirmModal(null);
                                } catch (error) {
                                  handleFirestoreError(error, OperationType.DELETE, `analyses/${analysis.id}`);
                                }
                              }
                            });
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-600 transition-all"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Credits Section */}
            <div className="px-4 py-4 border-t border-slate-100">
              <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-4 text-white shadow-lg shadow-blue-200">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-white/20 rounded-lg">
                      <Repeat className="w-4 h-4 text-white" />
                    </div>
                    <span className="text-xs font-bold uppercase tracking-wider">Credits</span>
                  </div>
                  {userProfile?.isPremium && (
                    <span className="px-2 py-0.5 bg-amber-400 text-amber-900 text-[10px] font-bold rounded-full">PREMIUM</span>
                  )}
                </div>
                <div className="text-2xl font-bold mb-1">
                  {userProfile?.role === 'admin' ? "Unlimited (Admin)" : (userProfile?.isPremium ? "Unlimited" : userProfile?.credits || 0)}
                </div>
                <p className="text-[10px] text-blue-100 mb-4">
                  {userProfile?.role === 'admin' ? "Administrator access" : (userProfile?.isPremium ? "Premium member access" : "10 credits per analysis")}
                </p>
                <button 
                  onClick={() => setIsPricingOpen(true)}
                  className="w-full py-2 bg-white text-blue-600 rounded-xl text-xs font-bold hover:bg-blue-50 transition-colors shadow-sm"
                >
                  {userProfile?.isPremium ? "Manage Plan" : "Get More Credits"}
                </button>
              </div>
            </div>

            {/* Admin Dashboard Link */}
            {userProfile?.role === 'admin' && (
              <div className="px-4 py-2">
                <button 
                  onClick={() => setIsAdminDashboardOpen(true)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-blue-50 hover:text-blue-600 rounded-xl transition-all group"
                >
                  <div className="p-2 bg-slate-100 group-hover:bg-blue-100 rounded-lg transition-colors">
                    <Layers className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-bold">Admin Dashboard</span>
                </button>
              </div>
            )}

            {/* User Profile */}
            <div className="p-4 border-t border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-3 mb-4">
                {user.photoURL ? (
                  <img src={user.photoURL} alt={user.displayName || ""} className="w-10 h-10 rounded-full border border-slate-200" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
                    <User className="w-6 h-6" />
                  </div>
                )}
                <div className="flex flex-col overflow-hidden">
                  <span className="text-sm font-bold text-slate-800 truncate">{user.displayName}</span>
                  <span className="text-xs text-slate-500 truncate">{user.email}</span>
                </div>
              </div>
              <button 
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>
          </motion.aside>

          {/* Main Content */}
          <div className="flex-1 flex flex-col h-screen overflow-hidden">
            {/* Top Install Banner - Removed as requested */}
            {/* {showInstallBtn && (
              <div className="bg-emerald-600 text-white px-6 py-2 flex items-center justify-between shadow-lg z-20">
                <div className="flex items-center gap-3">
                  <Download className="w-5 h-5" />
                  <span className="text-sm font-bold">Install Abir's Question Analyzer as a permanent app!</span>
                </div>
                <button 
                  onClick={handleInstallClick}
                  className="bg-white text-emerald-700 px-4 py-1 rounded-lg text-xs font-bold hover:bg-emerald-50 transition-colors"
                >
                  Install Now
                </button>
              </div>
            )} */}
            <header className="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-6 shrink-0">
              <div className="flex items-center gap-4">
                {!isSidebarOpen && (
                  <button onClick={() => setIsSidebarOpen(true)} className="p-2 hover:bg-slate-100 rounded-lg">
                    <BookOpen className="w-5 h-5 text-blue-600" />
                  </button>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-slate-400">Question Bank</span>
                  {activeSubject && (
                    <>
                      <ChevronRight className="w-4 h-4 text-slate-300" />
                      <span className="font-bold text-slate-900">{activeSubject.name}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest bg-slate-50 px-2 py-1 rounded">AI Analysis Active</span>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto bg-[#F8FAFC]">
              <div className="max-w-5xl mx-auto px-6 py-12">
                {!activeSubject ? (
                  <div className="text-center py-20">
                    <div className="w-20 h-20 bg-blue-50 rounded-3xl flex items-center justify-center mx-auto mb-6">
                      <Search className="w-10 h-10 text-blue-600" />
                    </div>
                    <h2 className="text-2xl font-bold text-slate-800 mb-2">Select a Subject</h2>
                    <p className="text-slate-500 max-w-sm mx-auto">
                      Choose a subject from the sidebar to start analyzing your question banks.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Hero Section */}
                    {!result && !isAnalyzing && (
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="text-center mb-16"
                      >
                        <h2 className="text-4xl font-extrabold text-slate-900 mb-6 tracking-tight">
                          Analyze <span className="text-blue-600">{activeSubject.name}</span>
                        </h2>
                        <p className="text-lg text-slate-600 max-w-2xl mx-auto mb-10">
                          Upload the question bank PDF for this subject. Our AI will extract patterns and generate an elaborate model question paper.
                        </p>

                        {/* Upload Zone */}
                        <div className="max-w-xl mx-auto space-y-4">
                          <div 
                            onClick={() => fileInputRef.current?.click()}
                            className="bg-white border-2 border-dashed border-slate-300 rounded-2xl p-12 cursor-pointer hover:border-blue-500 hover:bg-blue-50/30 transition-all group relative overflow-hidden shadow-sm"
                          >
                            <input 
                              type="file" 
                              ref={fileInputRef} 
                              onChange={handleFileUpload} 
                              accept=".pdf,image/*" 
                              className="hidden" 
                            />
                            <div className="flex flex-col items-center">
                              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                <Upload className="w-8 h-8 text-blue-600" />
                              </div>
                              <h3 className="text-lg font-semibold text-slate-800 mb-2">Upload PDF or Image</h3>
                              <p className="text-sm text-slate-500">Drag and drop or click to browse (PDF, JPG, PNG)</p>
                            </div>
                          </div>

                          <div className="flex items-center justify-center gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                            <input 
                              type="checkbox" 
                              id="ocr-mode" 
                              checked={useOCR}
                              onChange={(e) => setUseOCR(e.target.checked)}
                              className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                            />
                            <label htmlFor="ocr-mode" className="text-sm font-medium text-slate-700 cursor-pointer">
                              Enable OCR Mode (For scanned/image-based PDFs)
                            </label>
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {/* Loading State */}
                    <AnimatePresence>
                      {isAnalyzing && (
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className="max-w-md mx-auto bg-white rounded-2xl p-8 shadow-xl border border-slate-200 text-center space-y-6"
                        >
                          <div className="relative w-24 h-24 mx-auto">
                            <div className="absolute inset-0 border-4 border-slate-100 rounded-full"></div>
                            <svg className="absolute inset-0 w-24 h-24 rotate-[-90deg]">
                              <circle
                                cx="48"
                                cy="48"
                                r="44"
                                fill="transparent"
                                stroke="currentColor"
                                strokeWidth="8"
                                strokeDasharray={2 * Math.PI * 44}
                                strokeDashoffset={2 * Math.PI * 44 * (1 - progressPercentage / 100)}
                                className="text-blue-600 transition-all duration-500 ease-out"
                              />
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="text-xl font-bold text-slate-800">{progressPercentage}%</span>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <h3 className="text-xl font-bold text-slate-800">{progress}</h3>
                            {estimatedTimeRemaining !== null && (
                              <p className="text-sm text-slate-500 flex items-center justify-center gap-2">
                                <Clock className="w-4 h-4" />
                                Estimated time remaining: ~{estimatedTimeRemaining}s
                              </p>
                            )}
                          </div>

                          <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                            <motion.div 
                              className="h-full bg-blue-600"
                              initial={{ width: 0 }}
                              animate={{ width: `${progressPercentage}%` }}
                              transition={{ duration: 0.5 }}
                            />
                          </div>

                          <p className="text-xs text-slate-400 italic">
                            Please don't close this tab. Analyzing complex academic documents takes a moment.
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Error State */}
                    {error && (
                      <div className="max-w-md mx-auto bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 mb-8">
                        <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-bold text-red-800">Analysis Error</h4>
                          <p className="text-sm text-red-700">{error}</p>
                          <button 
                            onClick={() => { setError(null); setFile(null); }}
                            className="mt-2 text-xs font-bold text-red-600 uppercase tracking-wider hover:underline"
                          >
                            Try Again
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Results Dashboard */}
                    {result && (
                      <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="space-y-8"
                      >
                        {/* Header Actions */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div>
                            <h2 className="text-2xl font-bold text-slate-900">Analysis Results</h2>
                            <p className="text-slate-500">Based on {result.totalQuestions} identified questions</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <button 
                              onClick={() => { setResult(null); setFile(null); }}
                              className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                            >
                              Back
                            </button>
                            {!result.id && (
                              <div className="flex items-center gap-2">
                                <input 
                                  type="text"
                                  value={refineInput}
                                  onChange={(e) => setRefineInput(e.target.value)}
                                  placeholder="Refine analysis (e.g. 'Fix chapter X')..."
                                  className="px-4 py-2 text-sm border border-slate-200 rounded-lg w-64 focus:ring-2 focus:ring-blue-500"
                                />
                                <button 
                                  onClick={refineAnalysis}
                                  disabled={isRefining || !refineInput.trim()}
                                  className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-semibold hover:bg-slate-900 disabled:opacity-50"
                                >
                                  {isRefining ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refine"}
                                </button>
                              </div>
                            )}
                            {!result.id && (
                              <button 
                                onClick={() => saveAnalysis(result)}
                                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-200"
                              >
                                <Save className="w-4 h-4" />
                                Save Result
                              </button>
                            )}
                            <button 
                              onClick={generatePDFReport}
                              className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200"
                            >
                              <Download className="w-4 h-4" />
                              Export PDF
                            </button>
                          </div>
                        </div>

                        {/* Source Image (if available) */}
                        {result.sourceImage && (
                          <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm overflow-hidden">
                            <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4 px-2">Source Image</h3>
                            <div className="rounded-xl overflow-hidden border border-slate-100">
                              <img 
                                src={result.sourceImage} 
                                alt="Source document" 
                                className="w-full h-auto max-h-[500px] object-contain bg-slate-50"
                                referrerPolicy="no-referrer"
                              />
                            </div>
                          </div>
                        )}

                        {/* Stats Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                            <div className="flex items-center gap-3 mb-4">
                              <div className="p-2 bg-blue-50 rounded-lg">
                                <Layers className="w-5 h-5 text-blue-600" />
                              </div>
                              <span className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Chapters</span>
                            </div>
                            <div className="text-3xl font-bold text-slate-900">{result.chapters.length}</div>
                            <p className="text-sm text-slate-500 mt-1">Identified topics</p>
                          </div>

                          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                            <div className="flex items-center gap-3 mb-4">
                              <div className="p-2 bg-green-50 rounded-lg">
                                <Repeat className="w-5 h-5 text-green-600" />
                              </div>
                              <span className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Repeated</span>
                            </div>
                            <div className="text-3xl font-bold text-slate-900">
                              {result.questions.filter(q => q.frequency > 1).length}
                            </div>
                            <p className="text-sm text-slate-500 mt-1">Common questions</p>
                          </div>

                          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                            <div className="flex items-center gap-3 mb-4">
                              <div className="p-2 bg-purple-50 rounded-lg">
                                <BarChart3 className="w-5 h-5 text-purple-600" />
                              </div>
                              <span className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Top Chapter</span>
                            </div>
                            <div className="text-3xl font-bold text-slate-900 truncate">
                              {result.chapters.sort((a, b) => b.count - a.count)[0]?.name || "N/A"}
                            </div>
                            <p className="text-sm text-slate-500 mt-1">Highest weightage</p>
                          </div>
                        </div>

                        {/* Summary Card */}
                        <div className="bg-blue-600 rounded-2xl p-8 text-white shadow-xl">
                          <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                            <CheckCircle2 className="w-6 h-6" />
                            AI Insights Summary
                          </h3>
                          <div className="text-blue-50 leading-relaxed markdown-body">
                            <Markdown>{result.summary}</Markdown>
                          </div>
                        </div>

                        {/* Model Question Card */}
                        <div className="bg-white rounded-2xl p-8 border border-blue-200 shadow-xl relative overflow-hidden">
                          <div className="absolute top-0 right-0 p-4 opacity-10">
                            <BookOpen className="w-24 h-24 text-blue-600" />
                          </div>
                          <h3 className="text-xl font-bold text-slate-900 mb-4 flex items-center gap-2">
                            <BookOpen className="w-6 h-6 text-blue-600" />
                            Master Model Question Paper (8-Set Format)
                          </h3>
                          <div className="bg-blue-50 rounded-xl p-6 border border-blue-100">
                            <div className="text-slate-800 font-medium leading-relaxed markdown-body">
                              <Markdown>{result.modelQuestion}</Markdown>
                            </div>
                          </div>
                          <p className="mt-4 text-sm text-slate-500 italic">
                            This model paper is designed to cover the full syllabus based on identified patterns.
                          </p>
                        </div>

                        {/* Detailed Breakdown */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                          {/* Chapter Weightage */}
                          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                            <div className="p-6 border-b border-slate-100">
                              <h3 className="font-bold text-lg">Chapter Weightage</h3>
                            </div>
                            <div className="p-6 space-y-6">
                              {result.chapters.map((chapter, idx) => (
                                <div key={idx} className="space-y-2">
                                  <div className="flex justify-between text-sm font-medium">
                                    <span className="text-slate-700">{chapter.name}</span>
                                    <span className="text-slate-500">{chapter.percentage}%</span>
                                  </div>
                                  <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                                    <motion.div 
                                      initial={{ width: 0 }}
                                      animate={{ width: `${chapter.percentage}%` }}
                                      className="bg-blue-500 h-full rounded-full"
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Top Repeated Questions */}
                          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                            <div className="p-6 border-b border-slate-100">
                              <h3 className="font-bold text-lg">Most Repeated Questions</h3>
                            </div>
                            <div className="divide-y divide-slate-100">
                              {result.questions
                                .sort((a, b) => b.frequency - a.frequency)
                                .slice(0, 5)
                                .map((q, idx) => (
                                  <div key={idx} className="p-6 hover:bg-slate-50 transition-colors">
                                    <div className="flex items-start justify-between gap-4">
                                      <div className="space-y-1">
                                        <p className="text-sm font-medium text-slate-800 line-clamp-2">{q.text}</p>
                                        <div className="flex items-center gap-2">
                                          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-slate-100 text-slate-600 rounded">
                                            {q.chapter}
                                          </span>
                                          {q.years.length > 0 && (
                                            <span className="text-[10px] text-slate-400 flex items-center gap-1">
                                              <History className="w-3 h-3" />
                                              {q.years.join(", ")}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                      <div className="shrink-0 bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-bold">
                                        {q.frequency}x
                                      </div>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          </div>
                        </div>

                        {/* Full Question List */}
                        <div className="space-y-6">
                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <h3 className="font-bold text-xl text-slate-900">Master Question Bank</h3>
                            <div className="flex items-center gap-3">
                              <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                <input 
                                  type="text" 
                                  placeholder="Search questions..." 
                                  className="pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-full md:w-64"
                                  value={searchTerm}
                                  onChange={(e) => setSearchTerm(e.target.value)}
                                />
                              </div>
                              <span className="px-3 py-1 bg-blue-50 text-blue-700 text-xs font-bold rounded-full border border-blue-100 whitespace-nowrap">
                                {result.questions.length} Total
                              </span>
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {result.questions
                              .filter(q => 
                                q.text.toLowerCase().includes(searchTerm.toLowerCase()) || 
                                q.chapter.toLowerCase().includes(searchTerm.toLowerCase())
                              )
                              .map((q, idx) => (
                              <motion.div 
                                key={idx}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: idx * 0.05 }}
                                className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col"
                              >
                                <div className="p-6 flex-1">
                                  <div className="flex items-start justify-between gap-4 mb-4">
                                    <span className="px-2 py-1 bg-slate-100 text-slate-600 text-[10px] font-bold uppercase tracking-wider rounded">
                                      {q.chapter}
                                    </span>
                                    <div className="flex items-center gap-2">
                                      {q.frequency > 1 && (
                                        <span className="px-2 py-1 bg-green-100 text-green-700 text-[10px] font-bold rounded-full">
                                          {q.frequency}x Repeated
                                        </span>
                                      )}
                                      <button 
                                        onClick={() => fixQuestionWithAI(idx)}
                                        disabled={isFixingQuestion === idx}
                                        className="p-1.5 hover:bg-blue-50 text-blue-600 rounded-lg transition-colors flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider border border-transparent hover:border-blue-100"
                                        title="Fix unreadable text or signs with AI"
                                      >
                                        {isFixingQuestion === idx ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <Repeat className="w-3 h-3" />
                                        )}
                                        AI Fix
                                      </button>
                                    </div>
                                  </div>
                                  
                                  <p className="text-slate-800 font-medium leading-relaxed mb-4">
                                    {q.text}
                                  </p>
                                  
                                  {q.hasDiagram && (
                                    <div className="mb-4 p-4 bg-amber-50 border border-amber-100 rounded-xl">
                                      <div className="flex items-center gap-2 mb-2 text-amber-700">
                                        <Layers className="w-4 h-4" />
                                        <span className="text-xs font-bold uppercase tracking-wider">Diagram Included</span>
                                      </div>
                                      {q.diagramUrl ? (
                                        <div className="mb-3 rounded-lg overflow-hidden border border-amber-200 bg-white">
                                          <img 
                                            src={q.diagramUrl} 
                                            alt="AI Generated Diagram" 
                                            className="w-full h-auto object-contain"
                                            referrerPolicy="no-referrer"
                                          />
                                        </div>
                                      ) : null}
                                      <p className="text-xs text-amber-800 leading-relaxed italic">
                                        {q.diagramDescription || "This question includes a visual diagram or figure."}
                                      </p>
                                    </div>
                                  )}
                                </div>
                                
                                <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <History className="w-3.5 h-3.5 text-slate-400" />
                                    <span className="text-[10px] text-slate-500 font-medium">
                                      {q.years.length > 0 ? q.years.join(", ") : "No specific years mentioned"}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1 text-blue-600">
                                    <span className="text-[10px] font-bold uppercase tracking-widest">Question {idx + 1}</span>
                                  </div>
                                </div>
                              </motion.div>
                            ))}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
      {/* AI Help Center Floating Button */}
      <div className="fixed bottom-8 right-8 z-[150]">
        <AnimatePresence>
          {isHelpOpen && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="absolute bottom-20 right-0 w-80 h-[450px] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
            >
              <div className="p-4 bg-blue-600 text-white flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HelpCircle className="w-5 h-5" />
                  <span className="font-bold">AI Help Center</span>
                </div>
                <button onClick={() => setIsHelpOpen(false)} className="hover:bg-blue-700 p-1 rounded">
                  <ChevronLeft className="w-5 h-5 rotate-180" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="bg-blue-50 p-3 rounded-xl text-xs text-blue-800">
                  Hi! I'm your AI assistant. Ask me anything about how to use VersityAnalyzer or how to improve your analysis.
                </div>
                {helpMessages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] p-3 rounded-2xl text-sm ${m.role === 'user' ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-slate-100 text-slate-800 rounded-tl-none'}`}>
                      {m.text}
                    </div>
                  </div>
                ))}
                {isHelpLoading && (
                  <div className="flex justify-start">
                    <div className="bg-slate-100 p-3 rounded-2xl rounded-tl-none">
                      <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                    </div>
                  </div>
                )}
                <div ref={helpEndRef} />
              </div>
              
              <form onSubmit={handleHelpSubmit} className="p-4 border-t border-slate-100 flex gap-2">
                <input 
                  type="text"
                  value={helpInput}
                  onChange={(e) => setHelpInput(e.target.value)}
                  placeholder="Ask a question..."
                  className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button 
                  type="submit"
                  disabled={!helpInput.trim() || isHelpLoading}
                  className="p-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </form>
            </motion.div>
          )}
        </AnimatePresence>
        
        <button 
          onClick={() => setIsHelpOpen(!isHelpOpen)}
          className="w-14 h-14 bg-blue-600 text-white rounded-full shadow-xl flex items-center justify-center hover:scale-110 transition-transform active:scale-95"
        >
          {isHelpOpen ? <ChevronLeft className="w-6 h-6 rotate-180" /> : <HelpCircle className="w-6 h-6" />}
        </button>
      </div>

      {/* Modals */}
      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200]">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className={`px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border ${
              toast.type === 'success' 
                ? 'bg-emerald-50 border-emerald-100 text-emerald-700' 
                : 'bg-red-50 border-red-100 text-red-700'
            }`}
          >
            {toast.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
            <span className="font-semibold">{toast.message}</span>
          </motion.div>
        </div>
      )}
      {confirmModal?.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 border border-slate-200"
          >
            <h3 className="text-xl font-bold text-slate-900 mb-2">{confirmModal.title}</h3>
            <p className="text-slate-600 mb-6">{confirmModal.message}</p>
            <div className="flex gap-3">
              <button 
                onClick={() => setConfirmModal(null)}
                className="flex-1 py-2 text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={confirmModal.onConfirm}
                className="flex-1 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-lg shadow-red-200"
              >
                Delete
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Pricing Modal */}
      <AnimatePresence>
        {isPricingOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-3xl shadow-2xl max-w-4xl w-full overflow-hidden flex flex-col md:flex-row"
            >
              <div className="p-8 md:p-12 md:w-1/2 bg-slate-50 border-r border-slate-100">
                <div className="flex items-center gap-2 text-blue-600 mb-6 font-bold uppercase tracking-widest text-sm">
                  <BarChart3 className="w-5 h-5" />
                  VersityAnalyzer Pro
                </div>
                <h2 className="text-3xl font-bold text-slate-900 mb-4">Unlock the full power of AI Analysis</h2>
                <p className="text-slate-600 mb-8 leading-relaxed">
                  Get more credits to analyze complex question banks, generate diagrams, and use advanced OCR for handwritten notes.
                </p>
                
                <ul className="space-y-4 mb-8">
                  {[
                    "Unlimited AI Analysis",
                    "Advanced OCR for handwritten text",
                    "High-resolution AI Diagram generation",
                    "Priority support & cloud storage",
                    "Export to multiple formats"
                  ].map((feature, i) => (
                    <li key={i} className="flex items-center gap-3 text-sm text-slate-700 font-medium">
                      <CheckCircle2 className="w-5 h-5 text-green-500" />
                      {feature}
                    </li>
                  ))}
                </ul>
                
                <button 
                  onClick={() => setIsPricingOpen(false)}
                  className="text-slate-400 text-sm hover:text-slate-600 transition-colors"
                >
                  Maybe later, I'll stick with free credits
                </button>
              </div>
              
              <div className="p-8 md:p-12 md:w-1/2 flex flex-col justify-center space-y-6">
                {selectedPlanForPayment ? (
                  <div className="space-y-6">
                    <button 
                      onClick={() => setSelectedPlanForPayment(null)}
                      className="flex items-center gap-2 text-slate-500 hover:text-slate-700 text-sm font-medium transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      Back to Plans
                    </button>
                    
                    <div className="bg-blue-50 rounded-2xl p-6 border border-blue-100">
                      <h3 className="font-bold text-slate-900 mb-2">Pay via bKash/Nagad</h3>
                      <p className="text-sm text-slate-600 mb-4">
                        Send <span className="font-bold text-blue-600">{selectedPlanForPayment.amount} TK</span> to the following number:
                      </p>
                      <div className="space-y-2 font-mono text-sm bg-white p-3 rounded-xl border border-blue-100">
                        <div className="flex justify-between">
                          <span className="text-slate-500">bKash (Personal):</span>
                          <span className="font-bold text-slate-900">{appSettings?.bkashNumber || "017XXXXXXXX"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Nagad (Personal):</span>
                          <span className="font-bold text-slate-900">{appSettings?.nagadNumber || "017XXXXXXXX"}</span>
                        </div>
                      </div>
                      
                      <div className="mt-4 p-3 bg-white/50 rounded-xl border border-blue-50 text-[10px] text-slate-500 leading-relaxed whitespace-pre-wrap">
                        <span className="font-bold text-blue-600 uppercase block mb-1">Payment Manual:</span>
                        {appSettings?.paymentManual || (
                          <>
                            1. Open your bKash or Nagad app.<br/>
                            2. Select "Send Money".<br/>
                            3. Enter the number provided above.<br/>
                            4. Enter the amount: {selectedPlanForPayment.amount} TK.<br/>
                            5. Complete the transaction and copy the Transaction ID.<br/>
                            6. Select your payment method below and paste the ID.
                          </>
                        )}
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Payment Method</label>
                        <div className="grid grid-cols-2 gap-3">
                          {['bKash', 'Nagad'].map((m) => (
                            <button
                              key={m}
                              onClick={() => setPaymentMethod(m as any)}
                              className={`py-2 rounded-xl text-sm font-bold border-2 transition-all ${
                                paymentMethod === m 
                                  ? 'border-blue-500 bg-blue-50 text-blue-600' 
                                  : 'border-slate-100 text-slate-500 hover:border-slate-200'
                              }`}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Transaction ID</label>
                        <input 
                          type="text"
                          value={transactionId}
                          onChange={(e) => setTransactionId(e.target.value)}
                          placeholder="Enter Transaction ID"
                          className="w-full px-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-xl focus:border-blue-500 focus:outline-none transition-all font-mono text-sm"
                        />
                      </div>

                      <button 
                        onClick={submitPaymentRequest}
                        disabled={!transactionId.trim() || isSubmittingPayment}
                        className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-2"
                      >
                        {isSubmittingPayment ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            Submitting...
                          </>
                        ) : (
                          'Submit Payment Request'
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    {(appSettings?.packages || [
                      { id: "50", name: "Starter Pack", credits: 50, price: 50, description: "50 Analysis Credits", isPremium: false },
                      { id: "100", name: "6 Month Plan", credits: 100, price: 80, description: "100 Credits (Valid for 6 Months)", isPremium: false },
                      { id: "9999", name: "1 Year Premium", credits: 9999, price: 200, description: "Unlimited Analysis & PDF Downloads", isPremium: true }
                    ]).map((pkg) => (
                      <div 
                        key={pkg.id}
                        className={`p-6 border-2 rounded-2xl transition-all cursor-pointer group relative overflow-hidden ${
                          pkg.isPremium ? 'border-blue-500 bg-blue-50/50' : 'border-slate-100 hover:border-blue-500'
                        }`}
                      >
                        {pkg.isPremium && (
                          <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">
                            BEST VALUE
                          </div>
                        )}
                        <div className="flex justify-between items-center mb-2">
                          <span className="font-bold text-slate-900">{pkg.name}</span>
                          <span className="text-blue-600 font-bold">{pkg.price} TK</span>
                        </div>
                        <p className="text-xs text-slate-500 mb-4">{pkg.description}</p>
                        <button 
                          onClick={() => buyCredits(pkg.credits, pkg.price, pkg.name)}
                          className={`w-full py-2 rounded-xl text-sm font-bold transition-colors ${
                            pkg.isPremium 
                              ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-200' 
                              : 'bg-slate-900 text-white hover:bg-slate-800'
                          }`}
                        >
                          {pkg.isPremium ? 'Upgrade to Premium' : 'Buy Now'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                
                <p className="text-[10px] text-slate-400 text-center">
                  Secure payment via manual verification. No hidden fees. Cancel anytime.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Admin Dashboard */}
      <AnimatePresence>
        {isAdminDashboardOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl shadow-2xl max-w-5xl w-full h-[80vh] overflow-hidden flex flex-col"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-600 rounded-xl text-white">
                      <Layers className="w-6 h-6" />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-slate-900">Admin Dashboard</h2>
                      <p className="text-xs text-slate-500">Manage payment requests and user credits</p>
                    </div>
                  </div>
                  
                  <div className="flex bg-slate-200/50 p-1 rounded-xl">
                    {[
                      { id: 'requests', label: 'Requests', icon: Clock },
                      { id: 'settings', label: 'Settings', icon: Save },
                      { id: 'users', label: 'Users', icon: User }
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setAdminTab(tab.id as any)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                          adminTab === tab.id 
                            ? 'bg-white text-blue-600 shadow-sm' 
                            : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        <tab.icon className="w-4 h-4" />
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button 
                  onClick={() => setIsAdminDashboardOpen(false)}
                  className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                >
                  <ChevronLeft className="w-6 h-6 rotate-180" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                {adminTab === 'requests' && (
                  <div className="grid grid-cols-1 gap-6">
                    {paymentRequests.length === 0 ? (
                      <div className="text-center py-20">
                        <Clock className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                        <p className="text-slate-500 font-medium">No payment requests found.</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="border-b border-slate-100">
                              <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">User</th>
                              <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Plan</th>
                              <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Amount</th>
                              <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Method</th>
                              <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Transaction ID</th>
                              <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Status</th>
                              <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {paymentRequests.map((req) => (
                              <tr key={req.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                                <td className="py-4 px-4">
                                  <div className="text-sm font-bold text-slate-900">{req.userEmail}</div>
                                  <div className="text-[10px] text-slate-400 font-mono">{req.userId}</div>
                                </td>
                                <td className="py-4 px-4">
                                  <span className="px-2 py-1 bg-blue-50 text-blue-600 text-[10px] font-bold rounded-lg uppercase">
                                    {req.planId === '9999' ? 'Premium' : `${req.planId} Credits`}
                                  </span>
                                </td>
                                <td className="py-4 px-4 text-sm font-bold text-slate-900">{req.amount} TK</td>
                                <td className="py-4 px-4">
                                  <span className={`px-2 py-1 text-[10px] font-bold rounded-lg uppercase ${
                                    req.method === 'bKash' ? 'bg-pink-50 text-pink-600' : 'bg-orange-50 text-orange-600'
                                  }`}>
                                    {req.method}
                                  </span>
                                </td>
                                <td className="py-4 px-4 font-mono text-xs text-slate-600">{req.transactionId}</td>
                                <td className="py-4 px-4">
                                  <span className={`px-2 py-1 text-[10px] font-bold rounded-lg uppercase ${
                                    req.status === 'approved' ? 'bg-emerald-50 text-emerald-600' :
                                    req.status === 'rejected' ? 'bg-red-50 text-red-600' :
                                    'bg-amber-50 text-amber-600'
                                  }`}>
                                    {req.status}
                                  </span>
                                </td>
                                <td className="py-4 px-4">
                                  {req.status === 'pending' && (
                                    <div className="flex gap-2">
                                      <button 
                                        onClick={() => handleAdminAction(req.id!, 'approved')}
                                        className="p-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors shadow-sm"
                                        title="Approve"
                                      >
                                        <CheckCircle2 className="w-4 h-4" />
                                      </button>
                                      <button 
                                        onClick={() => handleAdminAction(req.id!, 'rejected')}
                                        className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors shadow-sm"
                                        title="Reject"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {adminTab === 'settings' && appSettings && (
                  <div className="max-w-2xl space-y-8">
                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">bKash Number</label>
                        <input 
                          type="text"
                          value={appSettings.bkashNumber}
                          onChange={(e) => setAppSettings({ ...appSettings, bkashNumber: e.target.value })}
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Nagad Number</label>
                        <input 
                          type="text"
                          value={appSettings.nagadNumber}
                          onChange={(e) => setAppSettings({ ...appSettings, nagadNumber: e.target.value })}
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Payment Manual (Markdown supported)</label>
                        <textarea 
                          value={appSettings.paymentManual}
                          onChange={(e) => setAppSettings({ ...appSettings, paymentManual: e.target.value })}
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none min-h-[150px] text-sm"
                          placeholder="Enter payment instructions..."
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <h3 className="font-bold text-slate-900 text-lg">Payment Packages</h3>
                        <button 
                          onClick={() => {
                            const newPkg = { id: Date.now().toString(), name: "New Package", credits: 0, price: 0, description: "", isPremium: false };
                            setAppSettings({ ...appSettings, packages: [...appSettings.packages, newPkg] });
                          }}
                          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-colors shadow-md"
                        >
                          <Plus className="w-4 h-4" />
                          Add Package
                        </button>
                      </div>

                      <div className="space-y-4">
                        {appSettings.packages.map((pkg, idx) => (
                          <div key={pkg.id} className="p-4 bg-slate-50 border border-slate-200 rounded-2xl relative group">
                            <button 
                              onClick={() => {
                                const newPkgs = appSettings.packages.filter((_, i) => i !== idx);
                                setAppSettings({ ...appSettings, packages: newPkgs });
                              }}
                              className="absolute top-4 right-4 p-2 text-red-500 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                              <div className="space-y-1">
                                <label className="text-[10px] font-bold text-slate-400 uppercase">Name</label>
                                <input 
                                  type="text"
                                  value={pkg.name}
                                  onChange={(e) => {
                                    const newPkgs = [...appSettings.packages];
                                    newPkgs[idx].name = e.target.value;
                                    setAppSettings({ ...appSettings, packages: newPkgs });
                                  }}
                                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-[10px] font-bold text-slate-400 uppercase">Credits</label>
                                <input 
                                  type="number"
                                  value={pkg.credits}
                                  onChange={(e) => {
                                    const newPkgs = [...appSettings.packages];
                                    newPkgs[idx].credits = parseInt(e.target.value);
                                    setAppSettings({ ...appSettings, packages: newPkgs });
                                  }}
                                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm"
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-[10px] font-bold text-slate-400 uppercase">Price (TK)</label>
                                <input 
                                  type="number"
                                  value={pkg.price}
                                  onChange={(e) => {
                                    const newPkgs = [...appSettings.packages];
                                    newPkgs[idx].price = parseInt(e.target.value);
                                    setAppSettings({ ...appSettings, packages: newPkgs });
                                  }}
                                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm"
                                />
                              </div>
                              <div className="flex items-center gap-2 pt-5">
                                <input 
                                  type="checkbox"
                                  checked={pkg.isPremium}
                                  onChange={(e) => {
                                    const newPkgs = [...appSettings.packages];
                                    newPkgs[idx].isPremium = e.target.checked;
                                    setAppSettings({ ...appSettings, packages: newPkgs });
                                  }}
                                  className="w-4 h-4 text-blue-600 rounded"
                                />
                                <label className="text-xs font-bold text-slate-600">Premium</label>
                              </div>
                            </div>
                            <div className="mt-4 space-y-1">
                              <label className="text-[10px] font-bold text-slate-400 uppercase">Description</label>
                              <input 
                                type="text"
                                value={pkg.description}
                                onChange={(e) => {
                                  const newPkgs = [...appSettings.packages];
                                  newPkgs[idx].description = e.target.value;
                                  setAppSettings({ ...appSettings, packages: newPkgs });
                                }}
                                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <button 
                      onClick={() => updateAppSettings(appSettings)}
                      className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200"
                    >
                      Save Global Settings
                    </button>
                  </div>
                )}

                {adminTab === 'users' && (
                  <div className="space-y-6">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-100">
                            <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">User</th>
                            <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Credits</th>
                            <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Status</th>
                            <th className="py-4 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {allUsers.map((u) => (
                            <tr key={u.userId} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                              <td className="py-4 px-4">
                                <div className="text-sm font-bold text-slate-900">{u.email}</div>
                                <div className="text-[10px] text-slate-400 font-mono">{u.userId}</div>
                              </td>
                              <td className="py-4 px-4">
                                <div className="flex items-center gap-2">
                                  <input 
                                    type="number"
                                    value={u.credits}
                                    onChange={(e) => {
                                      const val = parseInt(e.target.value);
                                      updateUserCredits(u.userId, val);
                                    }}
                                    className="w-20 px-2 py-1 bg-white border border-slate-200 rounded text-sm font-bold"
                                  />
                                  <span className="text-xs text-slate-400">Credits</span>
                                </div>
                              </td>
                              <td className="py-4 px-4">
                                <span className={`px-2 py-1 text-[10px] font-bold rounded-lg uppercase ${
                                  u.isPremium ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-600'
                                }`}>
                                  {u.isPremium ? 'Premium' : 'Free'}
                                </span>
                              </td>
                              <td className="py-4 px-4">
                                <button 
                                  onClick={() => {
                                    setConfirmModal({
                                      isOpen: true,
                                      title: "Cancel Credits",
                                      message: `Are you sure you want to reset ${u.email}'s credits to 0?`,
                                      onConfirm: () => {
                                        updateUserCredits(u.userId, 0);
                                        setConfirmModal(null);
                                      }
                                    });
                                  }}
                                  className="text-xs font-bold text-red-600 hover:text-red-700 px-3 py-1 bg-red-50 rounded-lg transition-colors"
                                >
                                  Cancel Credits
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* User Manual Modal */}
      <AnimatePresence>
        {isUserManualOpen && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full h-[80vh] overflow-hidden flex flex-col"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-blue-600 text-white">
                <div className="flex items-center gap-3">
                  <Info className="w-6 h-6" />
                  <h2 className="text-xl font-bold">User Manual</h2>
                </div>
                <button 
                  onClick={() => setIsUserManualOpen(false)}
                  className="p-2 hover:bg-white/20 rounded-full transition-colors"
                >
                  <ChevronLeft className="w-6 h-6 rotate-180" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-8 space-y-8 prose prose-slate max-w-none">
                <section>
                  <h3 className="text-blue-600 font-bold flex items-center gap-2">
                    <Plus className="w-5 h-5" />
                    1. Getting Started
                  </h3>
                  <p>
                    To begin, create a <strong>Subject</strong> from the sidebar. A subject acts as a folder for your question banks (e.g., "Physics 101", "Computer Science").
                  </p>
                </section>

                <section>
                  <h3 className="text-blue-600 font-bold flex items-center gap-2">
                    <Upload className="w-5 h-5" />
                    2. Analyzing Questions
                  </h3>
                  <p>
                    Select a subject and upload your question bank (PDF or Image). 
                  </p>
                  <ul className="list-disc pl-5 space-y-2">
                    <li><strong>Standard Mode:</strong> Fast and accurate for digital PDFs.</li>
                    <li><strong>OCR Mode:</strong> Use this for scanned documents or images of handwritten notes. It's slower but more powerful.</li>
                  </ul>
                  <p className="text-sm bg-amber-50 p-3 rounded-lg border border-amber-100 text-amber-700">
                    <strong>Note:</strong> Each analysis costs 10 credits. Premium users have unlimited access.
                  </p>
                </section>

                <section>
                  <h3 className="text-blue-600 font-bold flex items-center gap-2">
                    <BarChart3 className="w-5 h-5" />
                    3. Understanding Results
                  </h3>
                  <p>
                    After analysis, you'll see:
                  </p>
                  <ul className="list-disc pl-5 space-y-2">
                    <li><strong>Chapter Distribution:</strong> See which chapters are most important.</li>
                    <li><strong>Question Frequency:</strong> Identify questions that appear multiple times across years.</li>
                    <li><strong>Model Question Paper:</strong> A master paper generated by AI based on the most frequent topics.</li>
                  </ul>
                </section>

                <section>
                  <h3 className="text-blue-600 font-bold flex items-center gap-2">
                    <Download className="w-5 h-5" />
                    4. Exporting Reports
                  </h3>
                  <p>
                    Premium users can export the entire analysis as a professional PDF report, including all tables and the model paper.
                  </p>
                </section>

                <section>
                  <h3 className="text-blue-600 font-bold flex items-center gap-2">
                    <HelpCircle className="w-5 h-5" />
                    5. AI Help Center
                  </h3>
                  <p>
                    Need help? Use the chat bubble at the bottom right to ask our AI assistant anything about your analysis or how to use the app.
                  </p>
                </section>
              </div>
              
              <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-center">
                <button 
                  onClick={() => setIsUserManualOpen(false)}
                  className="px-8 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200"
                >
                  Got it, thanks!
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
