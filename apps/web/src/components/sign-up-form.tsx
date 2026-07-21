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

export default function SignUpForm({ onSwitchToSignIn }: { onSwitchToSignIn: () => void }) {
  const router = useRouter();
  const { isPending } = authClient.useSession();

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
      name: "",
    },
    onSubmit: async ({ value }) => {
      await authClient.signUp.email(
        {
          email: value.email,
          password: value.password,
          name: value.name,
        },
        {
          onSuccess: () => {
            router.push("/dashboard");
            toast.success("Sign up successful");
          },
          onError: (error) => {
            toast.danger(error.error.message || error.error.statusText);
          },
        },
      );
    },
    validators: {
      onSubmit: z.object({
        name: z.string().min(2, "Name must be at least 2 characters"),
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
        <Card.Title className="text-xl">Create account</Card.Title>
        <Card.Description>Get started with your free account</Card.Description>
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
          <form.Field name="name">
            {(field) => (
              <TextField
                isInvalid={field.state.meta.errors.length > 0}
                name={field.name}
                value={field.state.value}
                onChange={(value) => field.handleChange(value)}
              >
                <Label>Name</Label>
                <Input placeholder="Jane Doe" onBlur={field.handleBlur} />
                <FieldError>{field.state.meta.errors[0]?.message}</FieldError>
              </TextField>
            )}
          </form.Field>

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
                <Input placeholder="At least 8 characters" onBlur={field.handleBlur} />
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
                Sign Up
              </Button>
            )}
          </form.Subscribe>
        </form>
      </Card.Content>
      <Card.Footer className="justify-center">
        <p className="text-sm text-muted">
          Already have an account?{" "}
          <Link className="cursor-pointer" onPress={onSwitchToSignIn}>
            Sign In
          </Link>
        </p>
      </Card.Footer>
    </Card>
  );
}
