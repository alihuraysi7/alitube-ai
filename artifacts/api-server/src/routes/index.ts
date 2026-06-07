import { Router, type IRouter } from "express";
import healthRouter from "./health";
import translateRouter from "./translate";
import whisperRouter from "./whisper";
import ttsRouter from "./tts";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(translateRouter);
router.use(whisperRouter);
router.use(ttsRouter);
router.use(storageRouter);

export default router;
