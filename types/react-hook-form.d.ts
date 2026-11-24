declare module 'react-hook-form' {
  import { ReactNode, Ref } from 'react';

  export type FieldValues = Record<string, any>;
  export type FieldPath<TFieldValues extends FieldValues> = keyof TFieldValues & string;

  export interface FieldError {
    type: string;
    message?: string;
    ref?: Ref<any>;
  }

  export interface FieldErrors<TFieldValues = any> {
    [key: string]: FieldError | FieldErrors | undefined;
  }

  export interface UseFormRegisterReturn {
    onChange: (event: any) => void;
    onBlur: (event: any) => void;
    ref: Ref<any>;
    name: string;
  }

  export interface FormState<TFieldValues = any> {
    errors: FieldErrors<TFieldValues>;
    isDirty: boolean;
    isSubmitting: boolean;
    isValid: boolean;
    isValidating: boolean;
    submitCount: number;
    touchedFields: any;
    dirtyFields: any;
  }

  export interface UseFormReturn<TFieldValues = any> {
    register: (name: string, options?: any) => UseFormRegisterReturn;
    handleSubmit: (onValid: (data: TFieldValues) => void, onInvalid?: (errors: FieldErrors<TFieldValues>) => void) => (e?: React.BaseSyntheticEvent) => Promise<void>;
    formState: FormState<TFieldValues>;
    watch: (name?: string | string[]) => any;
    getValues: (name?: string | string[]) => any;
    setValue: (name: string, value: any, options?: any) => void;
    reset: (values?: TFieldValues, options?: any) => void;
    clearErrors: (name?: string | string[]) => void;
    setError: (name: string, error: FieldError) => void;
    trigger: (name?: string | string[]) => Promise<boolean>;
    getFieldState: (name: string, formState?: FormState<TFieldValues>) => any;
    control: any;
  }

  export interface UseFormProps<TFieldValues = any> {
    mode?: 'onBlur' | 'onChange' | 'onSubmit' | 'onTouched' | 'all';
    reValidateMode?: 'onBlur' | 'onChange' | 'onSubmit';
    defaultValues?: Partial<TFieldValues>;
    resolver?: any;
    context?: any;
    criteriaMode?: 'firstError' | 'all';
    shouldFocusError?: boolean;
    shouldUnregister?: boolean;
    delayError?: number;
  }

  export function useForm<TFieldValues = any>(props?: UseFormProps<TFieldValues>): UseFormReturn<TFieldValues>;

  export interface ControllerProps<
    TFieldValues extends FieldValues = FieldValues,
    TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
  > {
    name: TName;
    control: any;
    defaultValue?: any;
    rules?: any;
    render: (props: {
      field: any;
      fieldState: { error?: FieldError; invalid: boolean; isDirty: boolean; isTouched: boolean };
      formState: any;
    }) => ReactNode;
  }

  export function Controller<
    TFieldValues extends FieldValues = FieldValues,
    TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
  >(props: ControllerProps<TFieldValues, TName>): JSX.Element;

  export interface FormProviderProps<TFieldValues = any> {
    children: ReactNode;
  }

  export function FormProvider<TFieldValues = any>(props: UseFormReturn<TFieldValues> & FormProviderProps<TFieldValues>): JSX.Element;

  export function useFormContext<TFieldValues = any>(): UseFormReturn<TFieldValues>;

  export function useFormState<TFieldValues = any>(props?: { control?: any; name?: string | string[]; disabled?: boolean }): FormState<TFieldValues>;

  export function useController(props: { name: string; control: any; defaultValue?: any; rules?: any }): {
    field: any;
    fieldState: { error?: FieldError; invalid: boolean; isDirty: boolean; isTouched: boolean };
    formState: any;
  };

  export function useWatch(props: { control: any; name?: string | string[]; defaultValue?: any }): any;
}
