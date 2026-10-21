declare module 'framer-motion' {
  import { ComponentType, ReactNode, RefObject } from 'react';

  export interface MotionProps {
    initial?: any;
    animate?: any;
    exit?: any;
    transition?: any;
    variants?: any;
    whileHover?: any;
    whileTap?: any;
    whileInView?: any;
    viewport?: any;
    drag?: boolean | 'x' | 'y';
    dragConstraints?: any;
    dragElastic?: number;
    dragMomentum?: boolean;
    onDragStart?: (event: any, info: any) => void;
    onDrag?: (event: any, info: any) => void;
    onDragEnd?: (event: any, info: any) => void;
    style?: any;
    className?: string;
    children?: ReactNode;
    ref?: RefObject<any>;
    [key: string]: any;
  }

  export const motion: {
    div: ComponentType<MotionProps>;
    span: ComponentType<MotionProps>;
    p: ComponentType<MotionProps>;
    h1: ComponentType<MotionProps>;
    h2: ComponentType<MotionProps>;
    h3: ComponentType<MotionProps>;
    button: ComponentType<MotionProps>;
    a: ComponentType<MotionProps>;
    img: ComponentType<MotionProps>;
    section: ComponentType<MotionProps>;
    article: ComponentType<MotionProps>;
    [key: string]: ComponentType<MotionProps>;
  };

  export const AnimatePresence: ComponentType<{
    children?: ReactNode;
    mode?: 'sync' | 'wait' | 'popLayout';
    initial?: boolean;
    onExitComplete?: () => void;
  }>;

  export function useAnimation(): any;
  export function useMotionValue(initial: any): any;
  export function useTransform(...args: any[]): any;
  export function useScroll(options?: any): any;
  export function useSpring(value: any, config?: any): any;
  export function useInView(ref?: RefObject<any>, options?: any): boolean;
}
