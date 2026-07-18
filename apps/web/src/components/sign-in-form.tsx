"use client";

import {
  Button,
  Card,
  FieldError,
  Input,
  Label,
  Link,
  Spinner,
  TextField,
  toast,
} from "@heroui/react";
import { useForm } from "@tanstack/react-form";
import { useRouter } from "next/navigation";
import z from "zod";

import { authClient } from "@/lib/auth-client";

import Loader from "./loader";

export default function SignInForm({ onSwitchToSignUp }: { onSwitchToSignUp: () => void }) {
  const router = useRouter();
  const { isPending } = authClient.useSession();

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    onSubmit: async ({ value }) => {
      await authClient.signIn.email(
        {
          email: value.email,
          password: value.password,
        },
        {
          onSuccess: () => {
            router.push("/dashboard");
            toast.success("Sign in successful");
          },
          onError: (error) => {
            toast.danger(error.error.message || error.error.statusText);
          },
        },
      );
    },
    validators: {
      onSubmit: z.object({
        email: z.email("Invalid email address"),
        password: z.string().min(8, "Password must be at least 8 characters"),
      }),
    },
  });

  if (isPending) {
    return <Loader />;
  }

  return (
    <Card className="w-full max-w-md">
      <Card.Header>
        <Card.Title className="text-xl">Welcome back</Card.Title>
        <Card.Description>Sign in to your account to continue</Card.Description>
      </Card.Header>
      <Card.Content>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <form.Field name="email">
            {(field) => (
              <TextField
                isInvalid={field.state.meta.errors.length > 0}
                name={field.name}
                type="email"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
              >
                <Label>Email</Label>
                <Input placeholder="you@example.com" onBlur={field.handleBlur} />
                <FieldError>{field.state.meta.errors[0]?.message}</FieldError>
              </TextField>
            )}
          </form.Field>

          <form.Field name="password">
            {(field) => (
              <TextField
                isInvalid={field.state.meta.errors.length > 0}
                name={field.name}
                type="password"
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
              >
                <Label>Password</Label>
                <Input placeholder="••••••••" onBlur={field.handleBlur} />
                <FieldError>{field.state.meta.errors[0]?.message}</FieldError>
              </TextField>
            )}
          </form.Field>

          <form.Subscribe
            selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button
                className="mt-2 w-full"
                isDisabled={!canSubmit || isSubmitting}
                type="submit"
              >
                {isSubmitting ? <Spinner color="current" size="sm" /> : null}
                Sign In
              </Button>
            )}
          </form.Subscribe>
        </form>
      </Card.Content>
      <Card.Footer className="justify-center">
        <p className="text-sm text-muted">
          Need an account?{" "}
          <Link className="cursor-pointer" onPress={onSwitchToSignUp}>
            Sign Up
          </Link>
        </p>
      </Card.Footer>
    </Card>
  );
}
